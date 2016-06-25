export default (axios) => (sdk) => sdk(
    (url, data, headers) =>axios({
        method: 'POST',
        url,
        data,
        headers
    }),
    (url, data, headers) => axios({
        method: 'GET',
        url,
        params: data,
        headers
    })
);

