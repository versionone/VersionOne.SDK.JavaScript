[![Gitter](https://badges.gitter.im/versionone/VersionOne.SDK.JavaScript.svg)](https://gitter.im/versionone/VersionOne.SDK.JavaScript?utm_source=badge&utm_medium=badge&utm_campaign=pr-badge)

# VersionOne JavaScript SDK

The VersionOne JavaScript SDK is an open-source and community supported JavaScript client for the VersionOne API. The SDK simplifies the creation of  server-side JavaScript integrations (i.e. node/express server) with the VersionOne platform.

As an "open-sourced and community supported" product, the VersionOne JavaScript SDK is not formally supported by VersionOne.  That said, there are a number of options for getting your questions addressed:

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

## More Examples
Additional examples are available in the [examples](/examples) folder.

## Client Side Integrations 
As stated above, the VersionOne JavaScript SDK is intended for server-side integration. By default client-side integration is not possible because browsers only allow scripts to interact with web pages/applications at the same origin.  This restriction, known as the [same-origin policy (SOP)](https://en.wikipedia.org/wiki/Same-origin_policy), is intended to prevent malicious scripts from accessing sensitive data.  

The SOP can be overridden using a mechanism known as [Cross-origin resource sharing (CORS)](https://en.wikipedia.org/wiki/Cross-origin_resource_sharing). Enabling CORS opens a hole in the SOP and permits scripts to view data from another origin. This defeats the security measures intended to prevent a malicious attack.  

Enabling CORS is possible - *but not recommended* - for both hosted and on-premise installations of VersionOne.

If you are interested in enabling CORS in your on-premise instance you need to include an entry for ```CorsAllowedOrigins``` in your user.confg file.  The value attribute should contain the list of valid domains.  Only domains in this list will be allowed to make cross-origin requets. Separate domains names with a comma.    

Here is an example user.config file with CORS enabled for a single domain
```xml
<?xml version="1.0"?>
<appSettings>
    <add key="CorsAllowedOrigins" value="http://example.com" />
</appSettings>
```

Here is an example user.config file with CORS enabled for two domains
```xml
<?xml version="1.0"?>
<appSettings>
    <add key="CorsAllowedOrigins" value="http://example.com,http://localhost:8080" />
</appSettings>
```

If you are interested in enabling CORS for a hosted instance of VersionOne, please contact your system administrator and ask them to email VersionOne support requesting this change. This email needs to include the list of domains you would like permitted. Because this change has security implications, we cannot accept requests from anyone. 

## Other Resources

* [ACKNOWLEDGEMENTS.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/ACKNOWLEDGEMENTS.md) - Acknowledgments of included software and associated licenses
* [LICENSE.md](https://github.com/versionone/VersionOne.SDK.NET.APIClient/blob/master/LICENSE.md) - License for source code and redistribution
* [CONTRIBUTING.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/CONTRIBUTING.md) - Guidelines and information on contributing to this project

### Getting Help
Need to bootstrap on VersionOne SDK.JavaScript quickly? VersionOne services brings a wealth of development experience to training and mentoring:

http://www.versionone.com/training/product_training_services/

Not into the chat thing? Get help from the community of VersionOne developers:

http://groups.google.com/group/versionone-dev/
