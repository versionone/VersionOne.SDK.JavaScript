# VersionOne.SDK.JavaScript 

API client for use with JavaScript or CoffeeScript, either from Node.JS on the server, or (experimentally)
from a web browser.

## Getting Started With [`sample.js`](sample.js) on Node.js

To build the libraries, you'll need Node.js and CoffeeScript installed.

To install CoffeeScript:

`npm install coffee-script -g`

To install browserify globally (only needed if you want to build the `v1browsersdk.js` file)

`npm install browserify -g` 

Next, to install the other dependencies, type:

`npm install`

Finally, to build, type:

`. ./build.sh`

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

The VersionOne application does not currently have an option to enable CORS support. As such, CORS is not supported in our hosted environment. You can still use this JavaScript library for server-side applications. For client-side AJAX requests, the web pages must be sent to support to be hosted in your custom directory.

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
