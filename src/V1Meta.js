import btoa from 'btoa';
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
}