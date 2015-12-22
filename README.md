# VersionOne JavaScript SDK 

The VersionOne JavaScript SDK is an open-source and community supported client for the VersionOne API that can be used with JavaScript or CoffeeScript, either from Node.JS on the server or from a web browser.

As an open-sourced and community supported project, the VersionOne JavaScript SDK is not formally supported by VersionOne.

That said, there are a number of options for getting your questions addressed:

* [StackOverflow](http://stackoverflow.com/questions/tagged/versionone): For asking questions of the VersionOne Development Community.
* [GitHub Issues](https://github.com/versionone/VersionOne.SDK.JavaScript/issues): For submitting issues that others may try to address.

In general, StackOverflow is your best option for getting support for the VersionOne JavaScript SDK.

The source code for the VersionOne JavaScript SDK is free and open-source, and we encourage you to improve it by [submitting pull requests](https://help.github.com/articles/using-pull-requests)!

## Caveats

* 1.x.x SDK is only supported with a VersionOne instance ~15.3.
* 1.x.x SDK does not support querying for Meta definitions; please use any 0.x.x version.

## Installation

`npm install v1jssdk`

## Getting Started With [`sample.js`](sample.js) on Node.js

To build the libraries, you'll need Node.js.

```bash
npm install # install dependencies
npm run build # build distributable SDK
```

You can now run the sample against our public test instance by typing:

`node sample.js`

You can modify the info at the top of the script to point to your own VersionOne instance.

## Experimental: Use from a web browser

We're also are experimenting with getting this to work from the web browser. Here's a public example that is running:

http://jsfiddle.net/JoshGough/urq3D/

That script executes against a [public instance of VersionOne](http://ec2-54-205-135-234.compute-1.amazonaws.com/VersionOne/) that is hosted in Amazon.

The credentials for that instance are `admin` / `admin`.

That uses the `v1browsersdk.js` file that you can find in this repository. In order 
for the example to run in JSFiddle, it points to the one [deployed to the gh-pages branch](http://versionone.github.io/VersionOne.SDK.JavaScript/v1browsersdk.js).

The other information on the gh-pages branch is currently out of date as of November 2nd, 2013.

The `v1browsersdk.js` file is built by running this command:

`. ./make_browsersdk.sh`

### Configure your own on-premise VersionOne instance to allow CORS requests

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

## Other Resources

* [ACKNOWLEDGEMENTS.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/ACKNOWLEDGEMENTS.md) - Acknowledgments of included software and associated licenses
* [LICENSE.md](https://github.com/versionone/VersionOne.SDK.NET.APIClient/blob/master/LICENSE.md) - License for source code and redistribution
* [CONTRIBUTING.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/CONTRIBUTING.md) - Guidelines and information on contributing to this project

### Getting Help
Need to bootstrap on VersionOne SDK.JavaScript quickly? VersionOne services brings a wealth of development experience to training and mentoring:

http://www.versionone.com/training/product_training_services/

Not into the chat thing? Get help from the community of VersionOne developers:

http://groups.google.com/group/versionone-dev/
