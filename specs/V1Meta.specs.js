import sinon from 'sinon';
import Sut from './../src/V1Meta';

describe('src/V1Meta', function () {
	let assetTransform, getUrlForV1Server;
	describe('given a V1 instance server url, protocol, port, username, password, AJAX post method, and AJAX get method', () => {
		let v1ServerInfo, post, get, serverData;
		beforeEach(() => {
			v1ServerInfo = {
				url: 'some URL',
				protocol: 'https',
				port: '8081',
				username: 'admin',
				password: 'password'
			};
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
				let transformedAssetData, actual, url;
				beforeEach(() => {
					transformedAssetData = {Attributes: {Value: 20}};
					assetTransform = sinon.stub().withArgs(assetType, assetData).returns(transformedAssetData);
					url = 'my V1 Instance URL';
					getUrlForV1Server = sinon.stub().withArgs({...v1ServerInfo}).returns(url);
					Sut.__Rewire__('assetTransform', assetTransform);
					Sut.__Rewire__('getUrlForV1Server', getUrlForV1Server);
					actual = (new Sut({...v1ServerInfo, post, get})).create(assetType, assetData);
				});

				it('it should transform the asset type and asset attributes into a form the V1 API will understand', () => {
					assetTransform.calledWith(assetType, assetData).should.be.true;
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
});
