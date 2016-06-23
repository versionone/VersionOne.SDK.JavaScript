export function getUrlsForV1Server({hostname, instance, protocol, port}) {
    const rootUrl = getUrlToV1Server({hostname, instance, protocol, port});
    return {
        rest: () => restUrl(rootUrl),
        query: () => queryUrl(rootUrl),
        meta: () => metaUrl(rootUrl)
    };
}

function getUrlToV1Server({hostname, instance, protocol, port}) {
    let url = `${protocol}://${hostname}`;
    if (port) {
        url = `${url}:${port}`;
    }
    return `${url}/${instance}`;
}

const restUrl = rootUrl => `${rootUrl}/rest-1.v1/Data`;

const queryUrl = rootUrl => `${rootUrl}/query.v1`;

const metaUrl = rootUrl => `${rootUrl}/meta.v1`;
