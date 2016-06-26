import btoa from 'btoa';
import createMeta from './createMeta';

export {default as Oid} from './Oid';
export {default as jqueryConnector} from './connectors/jqueryConnector';
export {default as axiosConnector} from './connectors/axiosConnector';
export default (postFn, getFn) => (hostname, instance, port = 80, isHttps = false) => {
    const protocol = isHttps ? 'https' : 'http';
    return {
        withAccessToken: (token) => createMeta(
            hostname,
            instance,
            protocol,
            port,
            token,
            postFn,
            getFn
        ),
        withCreds: (username, password) => createMeta(
            hostname,
            instance,
            protocol,
            port,
            btoa(`${username}:${password}`),
            postFn,
            getFn
        )
    };
};
