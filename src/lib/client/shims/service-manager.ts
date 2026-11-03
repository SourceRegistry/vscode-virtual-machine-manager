// Shim for `@sourceregistry/sveltekit-service-manager/client`: webviews have no service routes.
export const publicBaseEntryPoint = '/__vmm_no_services__';

export const Service = {
	entryPoint: publicBaseEntryPoint
};
