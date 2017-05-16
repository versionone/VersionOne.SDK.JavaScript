[![Gitter](https://badges.gitter.im/versionone/VersionOne.SDK.JavaScript.svg)](https://gitter.im/versionone/VersionOne.SDK.JavaScript?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge)

# VersionOne JavaScript SDK

The VersionOne JavaScript SDK is an open-source and community supported JavaScript client for the VersionOne API. As an open-sourced and community supported project, the VersionOne JavaScript SDK is not formally supported by VersionOne.

With this said, there are a number of options for getting your questions addressed:

* [StackOverflow](http://stackoverflow.com/questions/tagged/versionone): For asking questions of the VersionOne Development Community.
* [GitHub Issues](https://github.com/versionone/VersionOne.SDK.JavaScript/issues): For submitting issues that others may try to address.
* [![Gitter](https://badges.gitter.im/versionone/VersionOne.SDK.JavaScript.svg)](https://gitter.im/versionone/VersionOne.SDK.JavaScript?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge): For participating in the development of the SDK and chatting with other developers.

In general, StackOverflow is your best option for getting support for the VersionOne JavaScript SDK.

The source code for the VersionOne JavaScript SDK is free and open-source, and we encourage you to improve it by [submitting pull requests](https://help.github.com/articles/using-pull-requests)!

# Getting Started

Please note:
* 2.x.x SDK is only supported with a VersionOne instance 17.1 or later.
* 1.x.x SDK is only supported with a VersionOne instance 15.3-17.0
* 1.x.x SDK currently does not support querying for Meta definitions; if this is something needed, please use any 0.x.x
version.

**See the repo's Wiki for API usage and additional information.**

## Installation via NPM

`npm install v1sdk`

## Configure your own on-premise VersionOne instance to allow CORS requests

The VersionOne application does not currently have an option to enable CORS support. As such, CORS is not supported in our hosted environment. You can still use this JavaScript library for server-side applications.

If you have your own on-premise installation, open the VersionOne `Web.config` file and add the three entires
after the `<add name="VersionOne" ... />` entry:

```xml
    <httpProtocol>
      <customHeaders>
        <clear />
        <add name="VersionOne" value="Enterprise/13.2.6.73; XP" />
      	<add name="Access-Control-Allow-Origin" value="*" />
      	<add name="Access-Control-Allow-Methods" value="GET,PUT,POST,DELETE,OPTIONS" />
      	<add name="Access-Control-Allow-Headers" value="Content-Type, Authorization" />
      </customHeaders>
    </httpProtocol>
```

## Example snippet
See more [examples](/examples).

### jQuery example
```javascript
import $ from 'jquery';
import sdk, {jqueryConnector} from 'v1sdk';

const jqueryConnectedSdk = jqueryConnector($)(sdk);
const v1 = jqueryConnectedSdk('www14.v1host.com', 'v1sdktesting', 443, true)
    .withCreds('admin', 'admin'); // usage with username/password
 // .withAccessToken('your token'); // usage with access tokens
 // .withImplicitAuth(); // let the browser do its thing

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
```

## Other Resources

* [ACKNOWLEDGEMENTS.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/ACKNOWLEDGEMENTS.md) - Acknowledgments of included software and associated licenses
* [LICENSE.md](https://github.com/versionone/VersionOne.SDK.NET.APIClient/blob/master/LICENSE.md) - License for source code and redistribution
* [CONTRIBUTING.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/CONTRIBUTING.md) - Guidelines and information on contributing to this project

### Getting Help
Need to bootstrap on VersionOne SDK.JavaScript quickly? VersionOne services brings a wealth of development experience to training and mentoring:

http://www.versionone.com/training/product_training_services/

Not into the chat thing? Get help from the community of VersionOne developers:

http://groups.google.com/group/versionone-dev/
