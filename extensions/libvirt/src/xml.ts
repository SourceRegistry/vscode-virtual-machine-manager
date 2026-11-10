/**
 * A small XML reader for what `virsh dumpxml` and `snapshot-dumpxml` print: elements, attributes, text.
 * No namespaces, DTDs or processing beyond skipping the prolog, comments and CDATA markers.
 */
export interface XmlNode {
	name: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
}

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };
const unescape = (value: string): string => value.replace(/&(lt|gt|amp|quot|apos);/g, (entity) => ENTITIES[entity]!);

export function parseXml(source: string): XmlNode {
	const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
	const stack: XmlNode[] = [root];
	const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
	let match: RegExpExecArray | null;
	while ((match = token.exec(source))) {
		const [, cdata, close, open, rawAttrs, selfClosing, text] = match;
		const top = stack[stack.length - 1]!;
		if (cdata !== undefined) top.text += cdata;
		else if (close !== undefined) {
			if (stack.length === 1 || top.name !== close) throw new Error(`Unexpected </${close}> in XML`);
			stack.pop();
		} else if (open !== undefined) {
			const attrs: Record<string, string> = {};
			for (const [, key, quoted] of (rawAttrs ?? '').matchAll(/([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/g)) attrs[key!] = unescape(quoted!.slice(1, -1));
			const node: XmlNode = { name: open, attrs, children: [], text: '' };
			top.children.push(node);
			if (!selfClosing) stack.push(node);
		} else if (text !== undefined) top.text += unescape(text);
	}
	if (stack.length !== 1) throw new Error(`Unclosed <${stack[stack.length - 1]!.name}> in XML`);
	const element = root.children[0];
	if (!element) throw new Error('No XML element found');
	return element;
}

/** First direct child called `name`. */
export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
	return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
	return node?.children.filter((c) => c.name === name) ?? [];
}

/** Trimmed text of the first direct child called `name`. */
export function textOf(node: XmlNode | undefined, name: string): string | undefined {
	const value = child(node, name)?.text.trim();
	return value === undefined || value === '' ? undefined : value;
}
