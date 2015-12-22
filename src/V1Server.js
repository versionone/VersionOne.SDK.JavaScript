export function getUrlsForV1Server({ hostname, instance, protocol, port }) {
	const rootUrl = getUrlToV1Server({hostname, instance, protocol, port});
	return {
		rest: () => restUrl(rootUrl),
		query: () => queryUrl(rootUrl)
	};
}

function getUrlToV1Server({ hostname, instance, protocol, port }) {
	let url = `${protocol}//${hostname}/${instance}`;
	if (port) {
		return `${url}:${port}`
	}
	return url;
}

function restUrl(rootUrl) {
	return `${rootUrl}/rest-1.v1/Data`;
}

function queryUrl(rootUrl) {
	return `${rootUrl}/query.v1`;
}
