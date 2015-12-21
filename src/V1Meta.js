import btoa from 'btoa';
import transformDataToAsset from './transformDataToAsset';
import {getUrlsForV1Server} from './V1Server';

export default class V1Meta {
	constructor({hostname, instance, protocol, port, username, password, post, get}) {
		this.urls = getUrlsForV1Server({hostname, instance, protocol, port});
		this.post = post;
		this.get = get;
		const encodedAuthenticationCredentials = btoa(`${username}:${password}`);
		this.authHeader = `Basic ${encodedAuthenticationCredentials}`;
	}

	create(assetType, assetAttributeData) {
		const postData = transformDataToAsset(assetType, assetAttributeData);
		return Promise.resolve(this.post(this.urls.rest(), postData, {Authorization: this.authHeader}));
	}
}