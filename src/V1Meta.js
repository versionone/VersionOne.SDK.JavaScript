import btoa from 'btoa';
import invariant from 'invariant';
import transformDataToAsset from './transformDataToAsset';
import {getUrlsForV1Server} from './V1Server';
import Oid from './Oid';

const createHeaderObj = authentication => {
    const headerObj = {
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };
    if (authentication) {
        headerObj.Authorization = authentication;
    }
    return headerObj;
};

export default class V1Meta {
    constructor({hostname, instance, protocol, port, username, password, postFn}) {
        this.urls = getUrlsForV1Server({hostname, instance, protocol, port});
        this.postFn = postFn;
        if (username && password) {
            const encodedAuthenticationCredentials = btoa(`${username}:${password}`);
            this.authHeader = `Basic ${encodedAuthenticationCredentials}`;
        }
    }

    create(assetType, assetAttributeData) {
        const postData = transformDataToAsset(assetAttributeData);
        const url = `${this.urls.rest()}/${assetType}`;
        const headers = createHeaderObj(this.authHeader);
        return Promise.resolve(this.postFn(url, postData, headers));
    }

    update(oidToken, assetType, assetData, changeComment) {
        const postData = transformDataToAsset(assetData);
        const url = `${this.urls.rest()}/${assetType}/${oidToken}` + (changeComment ? `?comment=${encodeURIComponent(changeComment)}` : '');
        const headers = createHeaderObj(this.authHeader);
        return Promise.resolve(this.postFn(url, postData, headers));
    }

    query(queryObj) {
        invariant(queryObj.from, `Error: there was no \`from\` property on provided query: ${queryObj}`);
        invariant(queryObj.select, `Error: there was no \`select\` property on provided query: ${queryObj}`);
        invariant(Array.isArray(queryObj.select), `Error: \`select\` property must be an Array on provided query: ${queryObj}`);
        const url = this.urls.query();
        const headers = createHeaderObj(this.authHeader);
        return Promise.resolve(this.postFn(url, queryObj, headers));
    }

    executeOperation(oidToken, operationName) {
        const oid = new Oid(oidToken);
        const url = `${this.urls.rest()}/${oid.assetType}/${oid.number}?op=${operationName}`;
        const headers = createHeaderObj(this.authHeader);
        return Promise.resolve(this.postFn(url, null, headers));
    }

    queryDefinition(assetType) {
        const url = `${this.urls.meta()}/${assetType}`;
        const headers = createHeaderObj(this.authHeader);
        return Promise.resolve(this.postFn(url, null, headers));
    }
}
