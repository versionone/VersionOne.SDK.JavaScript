# VersionOne.SDK.JavaScript 

API client for use with JavaScript or CoffeeScript, either from Node.JS on the server or within the web browser.

## Getting Started With Live Examples

The following JS Fiddle points to an instance behind the VersionOne firewall. Don't worry. We'll soon make this work against a public test instance and you'll be able to start learning the API right here.

## This example:

1. Imports the two VersionOne classes, V1Meta, and V1Server that are needed to communicate to a VersionOne instance.
2. Configures the server settings
3. Uses the query method to specify a `where` clause, a `select` list, and function callbacks for `success` and `error` results.

The callbacks use jQuery and jQuery UI features to render the output html.

## Try this:

Change `Username` to `Uuuusername`. This will force an error and should show a big, ugly message insteda of the beautiful jQuery accordion that you get on success. TODO: fix so this actually works...

<iframe style="width: 100%; height: 300px" src="http://jsfiddle.net/dFMZH/6/embedded/" allowfullscreen="allowfullscreen" frameborder="0"></iframe>