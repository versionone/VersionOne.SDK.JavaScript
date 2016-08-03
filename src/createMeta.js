import invariant from 'invariant';
import transformDataToAsset from './transformDataToAsset';
import getV1Urls from './getV1Urls';
import Oid from './Oid';

export default (hostname, instance, protocol, port, token, postFn, getFn, isBasic) => {
    const urls = getV1Urls(hostname, instance, protocol, port);
    const headers = createHeaderObj(token, isBasic);

    return {
        create(assetType, assetData) {
            invariant(assetType, `Error: there was no \`assetType\` provided to create`);
            invariant(assetData, `Error: there was no \`assetAttributeData\` provided to create`);
            invariant(Object.keys(assetData).length, `Error: there was no \`assetAttributeData\` provided to create`);
            const postData = transformDataToAsset(assetData);
            const url = `${urls.rest}/${assetType}`;
            return postFn(url, postData, headers);
        },

        update(oidToken, assetData, changeComment) {
            invariant(oidToken, `Error: there was no \`oidToken\` provided to update`);
            invariant(assetData, `Error: there was no \`assetAttributeData\` provided to update`);
            invariant(Object.keys(assetData).length, `Error: there was no \`assetAttributeData\` provided to update`);
            const oid = new Oid(oidToken);
            const postData = transformDataToAsset(assetData);
            const comment = changeComment ? `?comment=${encodeURIComponent(changeComment)}` : '';
            const url = `${urls.rest}/${oid.assetType}/${oidToken}${comment}`;
            return postFn(url, postData, headers);
        },

        query(queryObj) {
            invariant(queryObj.from, `Error: there was no \`from\` property on provided query: ${queryObj}`);
            invariant(queryObj.select, `Error: there was no \`select\` property on provided query: ${queryObj}`);
            invariant(Array.isArray(queryObj.select), `Error: \`select\` property must be an Array on provided query: ${queryObj}`);
            invariant(queryObj.select.length, `Error: \`select\` property must contain values on provided query: ${queryObj}`);
            const url = urls.query;
            return postFn(url, queryObj, headers);
        },

        executeOperation(oidToken, operationName) {
            invariant(oidToken, `Error: there was no \`oidToken\` provided to execute operation`);
            invariant(operationName, `Error: there was no \`operationName\` provided to execute operation`);
            const oid = new Oid(oidToken);
            const url = `${urls.rest}/${oid.assetType}/${oid.number}?op=${operationName}`;
            return postFn(url, null, headers);
        },

        queryDefinition(assetType) {
            const queryAssetType = assetType ? assetType : '';
            const url = `${urls.meta}/${queryAssetType}`;
            return getFn(url, null, headers);
        },

        getActivityStream(oidToken) {
            invariant(oidToken, `Error: there was no \`oidToken\` provided to execute operation`);
            const url = `${urls.activityStream}/${oidToken}`;
            return getFn(url, null, headers);
        }
    };
};

const createHeaderObj = (token, isBasic) => ({
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `${isBasic ? 'Basic' : 'Bearer'} ${token}`
});
