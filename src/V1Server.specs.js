import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import * as Sut from './V1Server';
chai.use(chaiAsPromised);
chai.should();

describe('src/V1Server', function() {
    let actual;
    describe('given a V1 instance server url, protocol, port, username, password', () => {
        let v1ServerInfo;
        beforeEach(() => {
            v1ServerInfo = {
                hostname: 'some URL',
                instance: 'some Instance',
                protocol: 'https',
                port: '8081'
            };
        });

        describe('when getting the Urls for the VersionOne instance', () => {
            beforeEach(() => {
                actual = Sut.getUrlsForV1Server(v1ServerInfo);
            });

            it('it should return a way to get the Rest API Url', () => {
                chai.should().exist(actual.rest);
            });
        });

        describe('when getting the rest Url', () => {
            beforeEach(() => {
                actual = Sut.getUrlsForV1Server(v1ServerInfo).rest();
            });

            it('it should return the Rest API Url', () => {
                actual.should.equal('https://some URL:8081/some Instance/rest-1.v1/Data');
            });
        });

        describe('when getting the query.v1 Url', () => {
            beforeEach(() => {
                actual = Sut.getUrlsForV1Server(v1ServerInfo).query();
            });

            it('it should return the Rest API Url', () => {
                actual.should.equal('https://some URL:8081/some Instance/query.v1');
            });
        });

        describe('when getting the meta.v1 Url', () => {
            beforeEach(() => {
                actual = Sut.getUrlsForV1Server(v1ServerInfo).meta();
            });

            it('it should return the Meta API Url', () => {
                actual.should.equal('https://some URL:8081/some Instance/meta.v1');
            });
        });
    });
});