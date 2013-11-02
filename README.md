# VersionOne.SDK.JavaScript 

API client for use with JavaScript or CoffeeScript, either from Node.JS on the server.

We're also are experimenting with getting this to work from the web browser. Here's a public example that is running:

http://jsfiddle.net/JoshGough/urq3D/

That uses the `v1browsersdk.js` file that you can find in this repository. In order 
for the example to run in JSFiddle, it points to the one [deployed to the gh-pages branch](http://versionone.github.io/VersionOne.SDK.JavaScript/v1browsersdk.js).

The other information on the gh-pages branch is currently out of date as of November 2nd, 2013.

The `v1browsersdk.js` file is built by running this command:

`. ./make_browsersdk.sh`

## Getting Started With [`sample.js`](sample.js) on Node.js

To build the libraries, you'll need Node.js and CoffeeScript installed.

To install CoffeeScript:

`npm install coffee-script -g`

To install browserify globally (only needed if you want to built the `v1browsersdk.js` file)

`npm install browserify -g` 

Next, to install the other dependencies, type:

`npm install`

Finally, to build, type:

`. ./build.sh`

You can now run the sample against our public test instance by typing:

`node sample.js`

You can modify the info at the top of the script to point to your own VersionOne instance.

## Other Resources

* [ACKNOWLEDGEMENTS.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/ACKNOWLEDGEMENTS.md) - Acknowledgments of included software and associated licenses
* [LICENSE.md](https://github.com/versionone/VersionOne.SDK.NET.APIClient/blob/master/LICENSE.md) - License for source code and redistribution
* [CONTRIBUTING.md](https://github.com/versionone/VersionOne.SDK.JavaScript/blob/master/CONTRIBUTING.md) - Guidelines and information on contributing to this project

### Getting Help
Need to bootstrap on VersionOne SDK.JavaScript quickly? VersionOne services brings a wealth of development experience to training and mentoring:

http://www.versionone.com/training/product_training_services/

You can also pop into our public HipChat room at: http://www.hipchat.com/grNeYfSGw

Not into the chat thing? Get help from the community of VersionOne developers:

http://groups.google.com/group/versionone-dev/
