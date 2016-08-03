import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import getV1Urls from './getV1Urls';
chai.use(chaiAsPromised);
chai.should();

describe('src/getV1Urls', function() {
    beforeEach(() => {
        this.actual = undefined;
    });
    describe('given a V1 hostname, instance name, protocol and port', () => {
        describe('when getting the URLs for the VersionOne instance', () => {
            beforeEach(() => {
                this.actual = getV1Urls('some URL', 'some Instance', 'https', 8081);
            });

            it('it should return the Rest API URL', () => {
                this.actual.rest.should.equal('https://some URL:8081/some Instance/rest-1.v1/Data');
            });
            it('it should return the Query API URL', () => {
                this.actual.query.should.equal('https://some URL:8081/some Instance/query.v1');
            });
            it('it should return the Meta API URL', () => {
                this.actual.meta.should.equal('https://some URL:8081/some Instance/meta.v1');
            });
            it('it should return the Activity Stream API URL', () => {
                this.actual.activityStream.should.equal('https://some URL:8081/some Instance/api/activityStream');
            });
        });
    });
});
