import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import Sut from './V1Meta';
chai.use(chaiAsPromised);
chai.should();

describe('src/V1Meta', function() {
    let transformDataToAsset, getUrlsForV1Server, actual;

    describe('given a V1 hostname, server instance, protocol, port, post and get methods and no username or password', () => {
        let v1ServerInfo, postFn;
        beforeEach(() => {
            v1ServerInfo = {
                hostname: 'some URL',
                instance: 'some instance',
                protocol: 'https',
                port: '8081'
            };
            postFn = sinon.stub().returns({then: () => serverData});
        });

        describe('when creating an asset', () => {
            let transformedAssetData, url, queryUrl, metaUrl, encodedCreds, btoa;
            beforeEach(() => {
                let assetType = 'Actual';
                let assetData = {};
                transformedAssetData = {Attributes: {Value: 20}};
                transformDataToAsset = sinon.stub().withArgs(assetType, assetData).returns(transformedAssetData);
                url = 'my V1 Instance URL';
                queryUrl = 'my query URL';
                metaUrl = 'my meta URL';
                encodedCreds = 'some encoded stuff';
                getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                    rest: sinon.stub().returns(url),
                    query: sinon.stub().returns(queryUrl),
                    meta: sinon.stub().returns(metaUrl)
                });
                btoa = sinon.stub().withArgs(`${v1ServerInfo.username}:${v1ServerInfo.password}`).returns(encodedCreds);
                Sut.__Rewire__('transformDataToAsset', transformDataToAsset);
                Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                Sut.__Rewire__('btoa', btoa);
                actual = (new Sut({...v1ServerInfo, postFn})).create(assetType, assetData);
            });

            afterEach(() => {
                sinon.restore(transformDataToAsset);
                sinon.restore(getUrlsForV1Server);
                sinon.restore(btoa);
            });

            it('it should not include authorization headers', () => {
                postFn.calledWith(`${url}/Actual`, transformedAssetData, {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                }).should.be.true;
            });
        });
    });

    describe('given a V1 hostname, server instance, protocol, port, username, password', () => {
        let v1ServerInfowithUsernamePassword, v1ServerInfo, serverData, btoa, expectedHeaders;
        beforeEach(() => {
            v1ServerInfo = {
                hostname: 'some URL',
                instance: 'some instance',
                protocol: 'https',
                port: '8081'
            };
            v1ServerInfowithUsernamePassword = {
                ...v1ServerInfo,
                username: 'username',
                password: 'password'
            };
            const encodedCreds = 'some encoded stuff';
            btoa = sinon.stub().withArgs(`${v1ServerInfo.username}:${v1ServerInfo.password}`).returns(encodedCreds);
            expectedHeaders = {
                Authorization: `Basic ${encodedCreds}`,
                Accept: 'application/json',
                'Content-Type': 'application/json'
            };
            Sut.__Rewire__('btoa', btoa);
        });

        afterEach(() => {
            sinon.restore(btoa);
        });

        describe('given a post method that does not return a ES2105 Promise', () => {
            let postFn, serverData;
            beforeEach(() => {
                serverData = {some: 'server data'};
                postFn = sinon.spy();
            });

            describe('when creating an asset', () => {
                beforeEach(() => {
                    let data = {...v1ServerInfowithUsernamePassword, postFn};
                    let sut = new Sut(data);
                    actual = sut.create('Actual', {});
                });

                it('it should return an ES2015 Promise', () => {
                    actual.should.be.an.instanceof(Promise);
                });

                it('it should provide the postFn a header object', () => {
                    let postCall = postFn.getCall(0);
                    let headerObj = postCall.args[2];
                    headerObj.should.be.eql(expectedHeaders);
                });
            });

            describe('when updating an asset', () => {
                beforeEach(() => {
                    actual = (new Sut({...v1ServerInfowithUsernamePassword, postFn})).update('Member:20', 'Member', {});
                });

                it('it should return an ES2015 Promise', () => {
                    actual.should.be.an.instanceof(Promise);
                });

                it('it should provide the postFn a header object', () => {
                    let postCall = postFn.getCall(0);
                    let headerObj = postCall.args[2];
                    headerObj.Accept.should.be.equal('application/json');
                    headerObj['Content-Type'].should.be.equal('application/json');
                });
            });

            describe('when executing an operation', () => {
                let operationName;
                beforeEach(() => {
                    operationName = 'someOperation';
                    actual = (new Sut({
                        ...v1ServerInfowithUsernamePassword,
                        postFn
                    })).executeOperation('Member', 'Member:20', operationName);
                });

                it('it should return an ES2015 Promise', () => {
                    actual.should.be.an.instanceOf(Promise);
                });
            });

            describe('when querying for data', () => {
                beforeEach(() => {
                    actual = (new Sut({ ...v1ServerInfowithUsernamePassword,
                        postFn
                    })).query({from: 'Epic', select: ['Name']})
                });
                it('it should return an ES2015 Promise', () => {
                    actual.should.be.an.instanceOf(Promise);
                });
            });

            describe('when querying for a definition', () => {
                beforeEach(() => {
                    actual = (new Sut({ ...v1ServerInfowithUsernamePassword,
                        postFn
                    })).queryDefinition("Story")
                });
                it('it should return an ES2015 Promise', () => {
                    actual.should.be.an.instanceOf(Promise);
                });
            });
        });

        describe('given post and get methods which does return an ES2015 promise', () => {
            let postFn, serverData;
            beforeEach(() => {
                serverData = {server: 'data'};
                postFn = sinon.stub().returns(new Promise((resolve) => {
                    resolve(serverData);
                }));
            });
            afterEach(() => {
                sinon.restore(postFn);
            });

            describe('given an asset type and asset attributes', () => {
                let assetType, assetData;
                beforeEach(() => {
                    assetType = 'Actual';
                    assetData = {
                        Value: 20,
                        Member: 'Member:20'
                    };
                });

                describe('when creating the asset', () => {
                    let transformedAssetData, url;
                    beforeEach(() => {
                        transformedAssetData = {Attributes: {Value: 20}};
                        transformDataToAsset = sinon.stub().withArgs(assetType, assetData).returns(transformedAssetData);
                        url = 'my V1 Instance URL';
                        getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                            rest: sinon.stub().returns(url)
                        });
                        Sut.__Rewire__('transformDataToAsset', transformDataToAsset);
                        Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                        actual = (new Sut({
                            ...v1ServerInfowithUsernamePassword,
                            postFn
                        })).create(assetType, assetData);
                    });

                    afterEach(() => {
                        sinon.restore(transformDataToAsset);
                        sinon.restore(getUrlsForV1Server);
                    });

                    it('it should transform the asset type and asset attributes into a form the V1 API will understand', () => {
                        transformDataToAsset.calledWith(assetData).should.be.true;
                    });

                    it('it should get the Rest URL to the V1 server instance', () => {
                        getUrlsForV1Server.calledWith({...v1ServerInfo}).should.be.true;
                    });

                    it('it should use the transformed asset data to post to V1 instance Url with basic auth headers', () => {
                        postFn.calledWith(`${url}/${assetType}`, transformedAssetData, expectedHeaders).should.be.true;
                    });

                    it('it should return a Promise which resolves to the v1Client\'s response upon success', (done) => {
                        actual.should.be.an.instanceof(Promise);
                        actual.should.eventually.equal(serverData).notify(done);
                    });
                });
            });

            describe('given an Oid token, asset type and asset attributes', () => {
                let oidToken, assetData, assetType;
                beforeEach(() => {
                    assetType = 'Actual';
                    oidToken = 'Member:20';
                    assetData = {};
                });
                afterEach(() => {
                    sinon.restore(transformDataToAsset);
                    sinon.restore(getUrlsForV1Server);
                });

                let transformedAssetData, url;
                describe('when updating the asset', () => {
                    beforeEach(() => {
                        transformedAssetData = {Attributes: {Value: 20}};
                        transformDataToAsset = sinon.stub().withArgs(assetData).returns(transformedAssetData);
                        url = 'my V1 Instance URL';
                        getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                            rest: sinon.stub().returns(url)
                        });
                        Sut.__Rewire__('transformDataToAsset', transformDataToAsset);
                        Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                        actual = (new Sut({...v1ServerInfowithUsernamePassword, postFn})).update(oidToken, assetType, assetData);
                    });
                    it('it should transform the asset attributes into a form the V1 API will understand', () => {
                        transformDataToAsset.calledWith(assetData).should.be.true;
                    });

                    it('it should call the get method with the transformed asset data', () => {
                        postFn.calledWith(`${url}/${assetType}/${oidToken}`, transformedAssetData, expectedHeaders).should.be.true;
                    });

                    it('it should return a Promise which resolves to the v1Client\'s response upon success', (done) => {
                        actual.should.be.an.instanceof(Promise);
                        actual.should.eventually.eql(serverData).notify(done);
                    });
                });
                describe('given a change comment', ()=> {
                    let changeComment = 'this is a really important change';
                    describe('when updating the asset', () => {
                        beforeEach(() => {
                            transformedAssetData = {Attributes: {Value: 20}};
                            transformDataToAsset = sinon.stub().withArgs(assetData).returns(transformedAssetData);
                            url = 'my V1 Instance URL';
                            getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                                rest: sinon.stub().returns(url)
                            });
                            Sut.__Rewire__('transformDataToAsset', transformDataToAsset);
                            Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                            actual = (new Sut({
                                ...v1ServerInfowithUsernamePassword,
                                postFn
                            })).update(oidToken, assetType, assetData, changeComment);
                        });

                        it('it should call the post method with the transformed asset data and the change comment as a query parameter', () => {
                            postFn.calledWith(`${url}/${assetType}/${oidToken}?comment=${encodeURIComponent(changeComment)}`, transformedAssetData, expectedHeaders).should.be.true;
                        });
                    });
                });
            });

            describe('given an invalid query object missing a from property', () => {
                let query;
                beforeEach(() => {
                    query = {};
                });
                describe('when querying V1 with the provided query object', () => {
                    let fn;
                    beforeEach(() => {
                        fn = () => (new Sut({...v1ServerInfowithUsernamePassword, postFn})).query(query);
                    });

                    it('it should throw an exception stating that a select property was not specified', () => {
                        chai.should().Throw(fn);
                    });
                });
            });

            describe('given an invalid query object missing a select property', () => {
                let query;
                beforeEach(() => {
                    query = {
                        from: 'Actual'
                    };
                });
                describe('when querying V1 with the provided query object', () => {
                    let fn;
                    beforeEach(() => {
                        fn = () => (new Sut({...v1ServerInfowithUsernamePassword, postFn})).query(query);
                    });

                    it('it should throw an exception stating that a select property was not specified', () => {
                        chai.should().Throw(fn);
                    });
                });
            });

            describe('given an invalid query object with a select property that is not an array', () => {
                let query;
                beforeEach(() => {
                    query = {
                        from: 'Actual',
                        select: 'Name'
                    };
                });
                describe('when querying V1 with the provided query object', () => {
                    let fn;
                    beforeEach(() => {
                        fn = () => (new Sut({...v1ServerInfowithUsernamePassword, postFn})).query(query);
                    });

                    it('it should throw an exception stating that a select property was not specified', () => {
                        chai.should().Throw(fn);
                    });
                });
            });

            describe('given a valid query object', () => {
                let query, queryV1Url, actual;
                beforeEach(() => {
                    query = {
                        from: 'Actual',
                        select: ['Name']
                    };
                });
                describe('when querying V1 with the provided query object', () => {
                    beforeEach(() => {
                        getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                            query: sinon.stub().returns(queryV1Url)
                        });

                        Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                        actual = (new Sut({
                            ...v1ServerInfowithUsernamePassword,
                            postFn
                        })).query(query);
                    });

                    it('it should use the query Url provided by the getUrlsForV1Server', () => {
                        getUrlsForV1Server.calledWith({...v1ServerInfo}).should.be.true;
                    });

                    it('it should use the provided post function and pass url, query, and authorization headers', () => {
                        postFn.calledWith(queryV1Url, query, expectedHeaders).should.be.true;
                    });

                    it('it should return a Promise which resolves to the v1Client\'s response upon success', (done) => {
                        actual.should.be.an.instanceof(Promise);
                        actual.should.eventually.eql(serverData).notify(done);
                    });
                });
            });

            describe('given an oid token and operation name', () => {
                let oidToken, operationName, url;
                beforeEach(() => {
                    oidToken = 'Member:20';
                    operationName = 'someOperation';
                });
                describe('when executing an operation', () => {
                    beforeEach(() => {
                        postFn = sinon.stub().returns(Promise.resolve());
                        getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                            rest: sinon.stub().returns(url)
                        });
                        Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                        actual = (new Sut({
                            ...v1ServerInfowithUsernamePassword,
                            postFn
                        })).executeOperation(oidToken, operationName);
                    });

                    it('it should provide the postFn with the proper API URL for the intended operation', () => {
                        postFn.calledWith(`${url}/Member/20?op=${operationName}`, null, expectedHeaders).should.be.true;
                    });
                });
            });

            describe('given an assetType', () => {
                let assetType, url;
                beforeEach(() => {
                    assetType = "Story"
                });
                describe('when query for a definition', () => {
                    beforeEach(() => {
                        postFn = sinon.stub().returns(Promise.resolve());
                        getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
                            meta: sinon.stub().returns(url)
                        });
                        Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
                        actual = (new Sut({
                            ...v1ServerInfowithUsernamePassword,
                            postFn
                        })).queryDefinition(assetType);
                    });

                    it('it should provide the postFn with the proper API URL for the assetType', () => {
                        postFn.calledWith(`${url}/${assetType}`, null, expectedHeaders).should.be.true;
                    });
                });
            });
        });
    });
});