export function getUrlsForV1Server({ hostname, instance, protocol, port }) {
	const rootUrl = getUrlToV1Server({hostname, instance, protocol, port });
	return {
		rest: () => restUrl(rootUrl)
	};
}

function getUrlToV1Server({ hostname, instance, protocol, port }) {
	return `${protocol}://${hostname}/${instance}:${port}`;
}

function restUrl(rootUrl) {
	return `${rootUrl}/rest-v1.v1`;
}
