import invariant from 'invariant';
import transformDataToAsset from './transformDataToAsset';
import {getUrlForV1Server} from './V1Server';

export default class V1Meta {
	constructor({url, protocol, port, username, password, post, get}) {
		this.url = getUrlForV1Server({url, protocol, port, username, password});
		this.post = post;
		this.get = get;
	}

	create(assetType, assetAttributeData) {
		const postData = transformDataToAsset(assetType, assetAttributeData);
		return Promise.resolve(this.post(this.url, postData));
	}
}