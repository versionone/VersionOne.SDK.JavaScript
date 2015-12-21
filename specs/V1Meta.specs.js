import sinon from 'sinon';
import Sut from './../src/V1Meta';

describe('src/V1Meta', function () {
	let transformDataToAsset, getUrlForV1Server, actual;
	describe('given a V1 instance server url, protocol, port, username, password', () => {
		let v1ServerInfo, serverData;
		beforeEach(() => {
			v1ServerInfo = {
				url: 'some URL',
				protocol: 'https',
				port: '8081',
				username: 'admin',
				password: 'password'
			};
		});

		describe('given post and get methods', () => {
			let post, get;
			beforeEach(() => {
				serverData = {server: 'data'};
				post = sinon.stub().returns(new Promise((resolve, reject) => {
					resolve(serverData);
				}));
				get = sinon.stub().returns(new Promise(()=> {
				}));
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
						getUrlForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns(url);
						Sut.__Rewire__('transformDataToAsset', transformDataToAsset);
						Sut.__Rewire__('getUrlForV1Server', getUrlForV1Server);
						actual = (new Sut({...v1ServerInfo, post, get})).create(assetType, assetData);
					});

					it('it should transform the asset type and asset attributes into a form the V1 API will understand', () => {
						transformDataToAsset.calledWith(assetType, assetData).should.be.true;
					});

					it('it should format the URL to the V1 server instance', () => {
						getUrlForV1Server.calledWith({...v1ServerInfo}).should.be.true;
					});

					it('it should use the transformed asset data to post to V1 instance URL', () => {
						post.calledWith(url, transformedAssetData).should.be.true;
					});

					it('it should return a Promise which resolves to the v1Client\'s response upon success', (done) => {
						actual.should.be.an.instanceof(Promise);
						actual.should.eventually.equal(serverData).notify(done);
					});
				});
			});
		});

		describe('given a post method that does not return a ES2105 Promise', () => {
			let post, get, serverData;
			beforeEach(() => {
				serverData = {some: 'server data'};
				post = sinon.stub().returns({then: () => serverData});
			});
			describe('given an asset type and asset attribute', () => {
				let assetType, assetData;
				beforeEach(() => {
					assetType = 'Actual';
					assetData = {
						Value: 20,
						Member: 'Member:20'
					};
				});
				describe('when creating an asset', () => {
					beforeEach(() => {
						actual = (new Sut({...v1ServerInfo, post, get})).create(assetType, assetData);
					});

					it('it should return an ES2015 Promise', () => {
						actual.should.be.an.instanceof(Promise);
					});
				});
			});
		});
	});
});