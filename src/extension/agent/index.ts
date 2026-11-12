/**
 * The machines as tools for AI agents (roadmap phase 21):
 *  - language model tools for agent mode inside VS Code (Copilot and other chat participants); VS Code shows
 *    its own confirmation for actions (`prepareInvocation`);
 *  - an MCP server for agents outside VS Code (Claude Code, other MCP clients), opt-in with `vmm.mcp.enabled`,
 *    on 127.0.0.1 with a bearer token; actions are confirmed in a VS Code dialog.
 * Destructive calls (power off, reset, revert or delete a snapshot) are refused unless `vmm.agent.allowDestructive`.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager, VmLocation } from '../clusters/ConnectionManager';
import type { VmControl } from '../api/VmControl';
import type { VmActivity } from '../activity/VmActivity';
import { errorMessage, scopedLogger } from '../util/log';
import { ExtensionAgentBackend } from './backend';
import { startMcpServer, type McpServerHandle, type McpToolInfo } from './mcpServer';
import { TOOLS, findTool, refusal, validateInput, type AgentBackend, type AgentTool } from './tools';

const TOKEN_SECRET = 'vmm.mcp.token';
const log = scopedLogger('agent');

const allowDestructive = () => vscode.workspace.getConfiguration('vmm.agent').get<boolean>('allowDestructive', false);
const toJson = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * Runs a tool after checking its input and whether agents may make this call at all, and after `confirm`
 * (the MCP path asks the user here; VS Code's agent mode asked already through `prepareInvocation`).
 */
export async function runTool(tool: AgentTool, input: unknown, backend: AgentBackend, destructiveAllowed: boolean, confirm?: (tool: AgentTool, input: unknown) => Promise<void>): Promise<string> {
	const invalid = validateInput(tool.inputSchema, input);
	if (invalid) throw new Error(`Invalid input for ${tool.name}: ${invalid}`);
	const refused = refusal(tool.risk(input as never), destructiveAllowed);
	if (refused) throw new Error(refused);
	await confirm?.(tool, input);
	return toJson(await tool.run(input as never, backend));
}

export function toolInfo(tool: AgentTool): McpToolInfo {
	// The risk can depend on the input (power: start vs. power off); the hint describes the worst case.
	const worst = tool.name === 'vmm_power_vm' ? 'destructive' : tool.risk({} as never);
	return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: worst === 'read', destructiveHint: worst === 'destructive', openWorldHint: false } };
}

export function registerAgentTools(context: vscode.ExtensionContext, manager: ConnectionManager, control: VmControl, activity: VmActivity): vscode.Disposable[] {
	const record = { record: (location: VmLocation, text: string, level?: 'info' | 'warn' | 'error') => activity.record(location.ref, text, level) };
	const chatBackend = new ExtensionAgentBackend(manager, control, record, 'an AI agent in VS Code');
	const mcpBackend = new ExtensionAgentBackend(manager, control, record, 'an MCP client');
	const disposables: vscode.Disposable[] = [];

	// Language model tools: declared in package.json `languageModelTools`, implemented here.
	if (vscode.lm?.registerTool) {
		for (const tool of TOOLS) {
			disposables.push(
				vscode.lm.registerTool<Record<string, unknown>>(tool.name, {
					prepareInvocation: (options) => {
						const risk = tool.risk(options.input as never);
						const what = tool.describe(options.input as never);
						if (risk === 'read') return { invocationMessage: what };
						const warning = risk === 'destructive' ? '\n\n**This cannot be undone.**' : '';
						return { invocationMessage: what, confirmationMessages: { title: tool.title, message: new vscode.MarkdownString(`${what}${warning}`) } };
					},
					invoke: async (options) => {
						try {
							return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(await runTool(tool, options.input, chatBackend, allowDestructive()))]);
						} catch (error) {
							log.warn(`${tool.name}: ${errorMessage(error)}`);
							throw error;
						}
					}
				})
			);
		}
	}

	// The MCP server, started and stopped with the setting.
	let server: McpServerHandle | undefined;
	let starting: Promise<void> | undefined;
	const token = async (): Promise<string> => {
		let value = await context.secrets.get(TOKEN_SECRET);
		if (!value) {
			value = randomBytes(32).toString('base64url');
			await context.secrets.store(TOKEN_SECRET, value);
		}
		return value;
	};
	const confirm = async (tool: AgentTool, input: unknown): Promise<void> => {
		const risk = tool.risk(input as never);
		if (risk === 'read') return;
		const choice = await vscode.window.showWarningMessage(
			`An MCP client wants to: ${tool.describe(input as never)}`,
			{ modal: true, detail: `Tool ${tool.name}, asked through the VM Manager MCP server.${risk === 'destructive' ? ' This cannot be undone.' : ''}` },
			'Allow'
		);
		if (choice !== 'Allow') throw new Error('The user declined this action.');
	};
	const stop = async () => {
		const running = server;
		server = undefined;
		if (running) {
			await running.close();
			log.info('MCP server stopped');
		}
	};
	const sync = async () => {
		const config = vscode.workspace.getConfiguration('vmm.mcp');
		await stop();
		if (!config.get<boolean>('enabled', false)) return;
		const port = config.get<number>('port', 7254);
		try {
			server = await startMcpServer({
				port,
				token: await token(),
				serverInfo: { name: 'vm-manager', version: String(context.extension.packageJSON.version ?? '0.0.0') },
				instructions: 'Virtual machines managed by VM Manager in VS Code. Start with vmm_list_vms. Actions are confirmed by the user in VS Code; destructive ones may be turned off.',
				tools: () => TOOLS.map(toolInfo),
				call: (name, args) => runTool(findTool(name)!, args, mcpBackend, allowDestructive(), confirm),
				log: (line) => log.info(`MCP ${line}`)
			});
			log.info(`MCP server listening on ${server.url}`);
		} catch (error) {
			const message = /EADDRINUSE/.test(String(error)) ? `Port ${port} is in use. Choose another one in the setting vmm.mcp.port.` : errorMessage(error);
			void vscode.window.showErrorMessage(`VM Manager could not start its MCP server: ${message}`);
		}
	};
	const restart = () => (starting = (starting ?? Promise.resolve()).then(sync, sync));

	disposables.push(
		vscode.workspace.onDidChangeConfiguration((event) => { if (event.affectsConfiguration('vmm.mcp')) void restart(); }),
		vscode.commands.registerCommand('vmm.mcp.copySetup', async () => {
			if (!vscode.workspace.getConfiguration('vmm.mcp').get<boolean>('enabled', false)) {
				const choice = await vscode.window.showInformationMessage('The MCP server for AI agents is off.', { modal: true, detail: 'It listens on 127.0.0.1 only and asks you before every action. Turn it on?' }, 'Turn On');
				if (choice !== 'Turn On') return;
				await vscode.workspace.getConfiguration('vmm.mcp').update('enabled', true, vscode.ConfigurationTarget.Global);
				await restart();
			}
			await starting;
			if (!server) return;
			const secret = await token();
			const json = toJson({ mcpServers: { 'vm-manager': { type: 'http', url: server.url, headers: { Authorization: `Bearer ${secret}` } } } });
			const pick = await vscode.window.showQuickPick(
				[
					{ label: 'Claude Code', description: 'claude mcp add …', value: `claude mcp add --transport http vm-manager ${server.url} --header "Authorization: Bearer ${secret}"` },
					{ label: 'JSON configuration', description: 'mcpServers entry for other MCP clients', value: json }
				],
				{ title: 'Copy MCP Server Setup', placeHolder: 'It contains the access token: keep it out of shared files and chats.' }
			);
			if (!pick) return;
			await vscode.env.clipboard.writeText(pick.value);
			void vscode.window.showInformationMessage(`Copied the ${pick.label} setup for ${server.url}. It holds the access token; "VM: Reset MCP Access Token" makes a new one.`);
		}),
		vscode.commands.registerCommand('vmm.mcp.resetToken', async () => {
			await context.secrets.delete(TOKEN_SECRET);
			await restart();
			void vscode.window.showInformationMessage('Made a new MCP access token. Clients set up with the old one must be set up again (VM: Copy MCP Server Setup).');
		}),
		{ dispose: () => void stop() }
	);
	void restart();
	return disposables;
}
