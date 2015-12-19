import assetTransform from './assetTransform';
import {getUrlForV1Server} from './V1Server';

export default class V1Meta {
	constructor({url, protocol, port, username, password, post, get}) {
		this.url = getUrlForV1Server({url, protocol, port, username, password});
		this.post = post;
		this.get = get;
	}

	create(assetType, assetAttributeData) {
		const postData = assetTransform(assetType, assetAttributeData);
		return this.post(this.url, postData);
	}
}