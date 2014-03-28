browserify -c 'coffee -sc' tests/browser/test_meta.coffee -o tests/browser/test_meta.js
browserify lib/v1browsersdk.js -o v1browsersdk.js
cp v1browsersdk.js tests/browser/
