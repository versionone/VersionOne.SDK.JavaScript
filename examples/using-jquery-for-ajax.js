import $ from 'jquery';
import sdk, {jqueryConnector} from 'v1sdk';

const jqueryConnectedSdk = jqueryConnector($)(sdk);
const v1 = jqueryConnectedSdk('www14.v1host.com', 'v1sdktesting', 443, true)
    .withCreds('admin', 'admin'); // usage with username/password
//  .withAccessToken('your token'); // usage with access tokens

v1.create('Story', {estimate: 5, status: 'Not Started'})
    .then((story) => v1.update(story.oidToken, {estimate: 7}))
    .then(v1.query({
        from: 'Story',
        select: ['Estimate', 'Status'],
        where: {
            Status: 'Not Started'
        }
    }))
    .then(console.log)
    .catch(console.log);

// Retrieve a description of all the Attributes, Operations for a given AssetType
v1.queryDefinition('Story')
    .then(console.log)
    .catch(console.log);
