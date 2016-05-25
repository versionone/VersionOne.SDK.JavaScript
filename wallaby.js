process.env.BABEL_ENV = 'test';
process.env.NODE_ENV = 'test';
var wallabyWebpack = require('wallaby-webpack');
var webpackPostprocessor = wallabyWebpack({});

module.exports = function wallabyConfig(wallaby) {
    return {
        files: [
            {pattern: 'node_modules/babel-polyfill/dist/polyfill.js', instrument: false},
            {pattern: 'node_modules/chai/chai.js', instrument: false},
            {pattern: 'node_modules/chai-as-promised/lib/chai-as-promised', instrument: false},
            {pattern: 'src/**/*.js', load: false},
            {pattern: '!src/**/*.specs.js'}
        ],
        tests: [
            {pattern: 'src/**/*.specs.js', load: false}
        ],
        compilers: {
            'src/**/*.js': wallaby.compilers.babel()
        },
        testFramework: 'mocha',
        postprocessor: webpackPostprocessor,
        setup: function setup() {
            chai.should();
            window.__moduleBundler.loadTests();
        }
    };
};
