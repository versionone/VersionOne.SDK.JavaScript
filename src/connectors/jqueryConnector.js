export default ($) => (sdk) => sdk(
    (url, data, headers) => new Promise((resolve, reject) => $.ajax(url, {
        method: 'POST',
        data,
        dataType: 'json',
        headers,
        success: resolve,
        error: reject
    })),
    (url, data, headers) => new Promise((resolve, reject) => $.ajax(url, {
        method: 'GET',
        data: JSON.stringify(data),
        headers,
        success: resolve,
        error: reject
    }))
);
