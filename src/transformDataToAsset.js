export default (assetData) => ({
    Attributes: reduceAssetData(assetData)
});

const reduceAssetData = (obj) => Object.keys(obj)
    .reduce((output, key) => {
        const attributeData = obj[key];
        if (Array.isArray(attributeData)) {
            return {
                ...output,
                [key]: {
                    name: key,
                    value: attributeData.map(reduceRelationalAttributes)
                }
            };
        }
        if (isFunction(attributeData)) {
            return {
                ...output,
                [key]: {
                    value: obj[key](),
                    act: 'set'
                }
            };
        }
        return {
            ...output,
            [key]: {
                value: obj[key],
                act: 'set'
            }
        };
    }, {});

const reduceRelationalAttributes = (obj) => {
    if (typeof obj === 'string') {
        return {
            idref: obj,
            act: 'add'
        };
    }
    return Object.keys(obj).reduce((output)=> {
        output.idref = obj.idref;
        output.act = obj.act ? obj.act : 'add';
        return output;
    }, {});
};

const isFunction = (obj) => obj && obj.constructor && obj.call && obj.apply;
