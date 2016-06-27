export default (hostname, instance, protocol, port) => {
    const rootUrl = getUrlToV1Server(hostname, instance, protocol, port);
    return Object.freeze({
        rest: `${rootUrl}/rest-1.v1/Data`,
        query: `${rootUrl}/query.v1`,
        meta: `${rootUrl}/meta.v1`
    });
};

const getUrlToV1Server = (hostname, instance, protocol, port) => `${protocol}://${hostname}:${port}/${instance}`;
