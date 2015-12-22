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
				name: key,
				value: attributeData.map(reduceRelationalAttributes)
			};
		}
		else {
			if (isFunction(attributeData)) {
				output[key] = {
					value: obj[key]()
				};
			}
			else {
				output[key] = {
					value: obj[key]
				};
			}
			output[key].act = 'set';
		}
		return output;
	}, {});
}

function reduceRelationalAttributes(obj) {
	if (typeof obj === 'string'){
		return {
			idref: obj,
			act: 'add'
		};
	}
	return Object.keys(obj).reduce((output, key)=> {
		output.idref = obj[key];
		output.act = obj.act ? obj.act : 'add';
		return output;
	}, {});
}

function isFunction(obj) {
	return obj && obj.constructor && obj.call && obj.apply;
}