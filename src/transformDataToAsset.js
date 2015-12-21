export default function (assetData) {
	return {
		Attributes: reduceAssetData(assetData)
	};
}

function reduceAssetData(obj) {
	return Object.keys(obj).reduce((output, key) => {
		const attributeData = obj[key];
		if (Array.isArray(attributeData)) {
			output[key] = {
				_type: 'Relation',
				value: attributeData.map(reduceRelationalAttributes)
			};
		}
		else if (isFunction(attributeData)) {
			output[key] = {
				value: obj[key]()
			};
		}
		else {
			console.log(attributeData);
			output[key] = {
				value: obj[key]
			};
		}
		return output;
	}, {});
}

function reduceRelationalAttributes(obj) {
	return Object.keys(obj).reduce((output, key)=> {
		output[key] = obj[key];
		return output;
	}, {});
}

function isFunction(obj) {
	return obj && obj.constructor && obj.call && obj.apply;
}