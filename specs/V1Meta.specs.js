import sinon from 'sinon';
import should from './setup';
import Sut from './../src/V1Meta';

describe('src/V1Meta', function () {
	let transformDataToAsset, getUrlsForV1Server, actual;
	describe('given a V1 hostname, server instance, protocol, port, username, password', () => {
		let v1ServerInfo, serverData;
		beforeEach(() => {
			v1ServerInfo = {
				hostname: 'some URL',
				instance: 'some instance',
				protocol: 'https',
				port: '8081'
			};
		});

		describe('given a post method that does not return a ES2105 Promise', () => {
			let postFn, getFn, serverData;
			beforeEach(() => {
				serverData = {some: 'server data'};
				postFn = sinon.stub().returns({then: () => serverData});
				getFn = sinon.stub().returns({then: () => serverData});
			});

			describe('when creating an asset', () => {
				beforeEach(() => {
					actual = (new Sut({...v1ServerInfo, postFn, getFn})).create('Actual', {});
				});

				it('it should return an ES2015 Promise', () => {
					actual.should.be.an.instanceof(Promise);
				});
			});

			describe('when updating an asset', () => {
				beforeEach(() => {
					actual = (new Sut({...v1ServerInfo, postFn, getFn})).update('Member:20', 'Member', {});
				});

				it('it should return an ES2015 Promise', () => {
					actual.should.be.an.instanceof(Promise);
				});
			});
		});

		describe('given post and get methods which return an ES2015 promise', () => {
			let postFn, getFn, serverData;
			beforeEach(() => {
				serverData = {server: 'data'};
				postFn = sinon.stub().returns(new Promise((resolve) => {
					resolve(serverData);
				}));
				getFn = sinon.stub().returns(new Promise((resolve)=> {
					resolve(serverData);
				}));
			});
			afterEach(() => {
				sinon.restore(postFn);
				sinon.restore(getFn);
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
					let transformedAssetData, url, encodedCreds, btoa;
					beforeEach(() => {
						transformedAssetData = {Attributes: {Value: 20}};
						transformDataToAsset = sinon.stub().withArgs(assetType, assetData).returns(transformedAssetData);
						url = 'my V1 Instance URL';
						encodedCreds = 'some encoded stuff';
						getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
							rest: sinon.stub().returns(url)
						});
						btoa = sinon.stub().withArgs(`${v1ServerInfo.username}:${v1ServerInfo.password}`).returns(encodedCreds);
						Sut.__Rewire__('transformDataToAsset', transformDataToAsset);
						Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
						Sut.__Rewire__('btoa', btoa);
						actual = (new Sut({...v1ServerInfo, postFn, getFn})).create(assetType, assetData);
					});

					afterEach(() => {
						sinon.restore(transformDataToAsset);
						sinon.restore(getUrlsForV1Server);
						sinon.restore(btoa);
					});

					it('it should transform the asset type and asset attributes into a form the V1 API will understand', () => {
						transformDataToAsset.calledWith(assetData).should.be.true;
					});

					it('it should get the Rest URL to the V1 server instance', () => {
						getUrlsForV1Server.calledWith({...v1ServerInfo}).should.be.true;
					});

					it('it should use the transformed asset data to post to V1 instance Url with basic auth headers', () => {
						postFn.calledWith(`${url}/${assetType}`, transformedAssetData, {Authorization: `Basic ${encodedCreds}`}).should.be.true;
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
						actual = (new Sut({...v1ServerInfo, postFn, getFn})).update(oidToken, assetType, assetData);
					});
					it('it should transform the asset attributes into a form the V1 API will understand', () => {
						transformDataToAsset.calledWith(assetData).should.be.true;
					});

					it('it should call the get method with the transformed asset data', () => {
						getFn.calledWith(`${url}/${assetType}`, transformedAssetData).should.be.true;
					});

					it('it should return a Promise which resolves to the v1Client\'s response upon success', (done) => {
						actual.should.be.an.instanceof(Promise);
						actual.should.eventually.eql(serverData).notify(done);
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
						fn = () => (new Sut({...v1ServerInfo, postFn, getFn})).query(query);
					});

					it('it should throw an exception stating that a select property was not specified', () => {
						should.Throw(fn);
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
						fn = () => (new Sut({...v1ServerInfo, postFn, getFn})).query(query);
					});

					it('it should throw an exception stating that a select property was not specified', () => {
						should.Throw(fn);
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
						fn = () => (new Sut({...v1ServerInfo, postFn, getFn})).query(query);
					});

					it('it should throw an exception stating that a select property was not specified', () => {
						should.Throw(fn);
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
					let fn;
					beforeEach(() => {
						getUrlsForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns({
							query: sinon.stub().returns(queryV1Url)
						});
						Sut.__Rewire__('getUrlsForV1Server', getUrlsForV1Server);
						actual = (new Sut({...v1ServerInfo, postFn, getFn})).query(query);
					});

					it('it should use the query Url provided by the getUrlsForV1Server', () => {
						getUrlsForV1Server.calledWith({...v1ServerInfo}).should.be.true;
					});

					it('it should use the provided get function and pass url and pass the query as the payload', () => {
						getFn.calledWith(queryV1Url, query).should.be.true;
					});

					it('it should return a Promise which resolves to the v1Client\'s response upon success', (done) => {
						actual.should.be.an.instanceof(Promise);
						actual.should.eventually.eql(serverData).notify(done);
					});
				});
			});
		});
	});
});