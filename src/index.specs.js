import sdk, {Oid, __RewireAPI__ as RewireApi} from './index';
import oid from './Oid';
import sinon from 'sinon';

describe('when loading the module', function() {
    it('it should export the sdk as the default', () => {
        sdk.should.be.a('function');
    });
    it('it should export Oid', () => {
        Oid.should.equal(oid);
    });

    beforeEach(() => {
        this.actual = undefined;
    });

    describe('given a post and get AJAX function', () => {
        beforeEach(() => {
            this.postFn = sinon.stub();
            this.getFn = sinon.stub();
            this.sdk = sdk(this.postFn, this.getFn);
        });
        it('it should return a function to set V1 host information', () => {
            this.sdk.should.be.a('function');
        });

        describe('given a hostname, instance name, port, and https protocol', () => {
            beforeEach(() => {
                this.setSecurity = this.sdk('hostname', 'instance', 80, true);
            });
            it('it should return a meta object with function to authenticate via username and password', () => {
                this.setSecurity.withCreds.should.be.a('function');
            });
            it('it should return a meta object with function to authenticate via an access token', () => {
                this.setSecurity.withAccessToken.should.be.a('function');
            });

            describe('given an access token', () => {
                beforeEach(() => {
                    this.accessToken = 'access token';
                });
                describe('when creating the SDK', () => {
                    beforeEach(() => {
                        this.metaStub = sinon.mock()
                            .withExactArgs('hostname', 'instance', 'https', 80, this.accessToken, this.postFn, this.getFn, false)
                            .returns('meta');
                        RewireApi.__Rewire__('createMeta', this.metaStub);
                        this.meta = this.setSecurity.withAccessToken(this.accessToken);
                    });
                    it('it should return a Meta object with the access token, hostname, instance, port, protocol, post and get functions', () => {
                        this.meta.should.equal('meta');
                    });
                });
            });

            describe('given a username and password', () => {
                beforeEach(() => {
                    this.username = 'username';
                    this.password = 'password';
                });
                describe('when creating the SDK', () => {
                    beforeEach(() => {
                        this.token = 'username token';
                        this.metaStub = sinon.mock()
                            .withExactArgs('hostname', 'instance', 'https', 80, this.token, this.postFn, this.getFn, true)
                            .returns('meta1');
                        this.btoa = sinon.mock()
                            .withArgs(`${this.username}:${this.password}`)
                            .returns(this.token);
                        RewireApi.__Rewire__('createMeta', this.metaStub);
                        RewireApi.__Rewire__('btoa', this.btoa);
                        this.meta = this.setSecurity.withCreds(this.username, this.password);
                    });
                    it('it should return a Meta object with the username/password encoded token, hostname, instance, port, protocol, post and get functions', () => {
                        this.meta.should.equal('meta1');
                    });
                });
            });
        });
    });
});
