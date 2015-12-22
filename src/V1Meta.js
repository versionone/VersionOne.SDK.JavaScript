import btoa from 'btoa';
import invariant from 'invariant';
import transformDataToAsset from './transformDataToAsset';
import {getUrlsForV1Server} from './V1Server';

export default class V1Meta {
	constructor({hostname, instance, protocol, port, username, password, postFn, getFn}) {
		this.urls = getUrlsForV1Server({hostname, instance, protocol, port});
		this.postFn = postFn;
		this.getFn = getFn;
		const encodedAuthenticationCredentials = btoa(`${username}:${password}`);
		this.authHeader = `Basic ${encodedAuthenticationCredentials}`;
	}

	create(assetType, assetAttributeData) {
		const postData = transformDataToAsset(assetAttributeData);
		const url = `${this.urls.rest()}/${assetType}`;
		return Promise.resolve(this.postFn(url, postData, {Authorization: this.authHeader}));
	}

	update(oidToken, assetType, assetData) {
		const postData = transformDataToAsset(assetData);
		const url = `${this.urls.rest()}/${assetType}`;
		return Promise.resolve(this.getFn(url, postData));
	}

	query(queryObj) {
		invariant(queryObj.from, `Error: there was no \`from\` property on provided query: ${queryObj}`);
		invariant(queryObj.select, `Error: there was no \`from\` property on provided query: ${queryObj}`);
		invariant(Array.isArray(queryObj.select), `Error: there was no \`from\` property on provided query: ${queryObj}`);
		const url = this.urls.query();
		return this.getFn(url, queryObj);
	}
}
