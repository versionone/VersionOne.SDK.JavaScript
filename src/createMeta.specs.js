import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import createMeta, {__RewireAPI__ as RewireApi} from './createMeta';
import sinon from 'sinon';
chai.use(chaiAsPromised);
chai.should();

describe('src/meta', function() {
    beforeEach(() => {
        this.actual = undefined;
    });
    describe('given a required meta creation information', () => {
        beforeEach(() => {
            this.postFn = sinon.stub();
            this.getFn = sinon.stub();
        });
        describe('when creating a meta object', () => {
            beforeEach(() => {
                this.actual = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, false);
            });
            it('it should return an object with a create asset function', () => {
                this.actual.create.should.be.a('function');
            });
            it('it should return an object with an update asset function', () => {
                this.actual.update.should.be.a('function');
            });
            it('it should return an object with a query function', () => {
                this.actual.query.should.be.a('function');
            });
            it('it should return an object with an execution operation function', () => {
                this.actual.executeOperation.should.be.a('function');
            });
            it('it should return an object with a query definition function', () => {
                this.actual.queryDefinition.should.be.a('function');
            });
            it('it should return an object with a activity stream function', () => {
                this.actual.getActivityStream.should.be.a('function');
            });
        });
    });
});

describe('src/meta.create', function() {
    beforeEach(() => {
        this.actual = undefined;
    });
    describe('given no asset type', () => {
        beforeEach(() => {
            this.meta = createMeta('h', 'i', 'http', 80, 'token', () => {
            }, () => {
            }, false);
        });
        describe('when creating an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.create()).should.throw();
            });
        });
    });
    describe('given no asset data', () => {
        describe('when creating an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.create('Actual')).should.throw();
            });
        });
    });
    describe('given empty asset data', () => {
        describe('when creating an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.create('Actual', {})).should.throw();
            });
        });
    });
    describe('given token based authentication', () => {
        describe('given an asset type and asset data', () => {
            describe('when creating an asset', () => {
                beforeEach(() => {
                    this.assetData = {key: 'value'};
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            rest: 'rest URL'
                        });
                    const transformDataToAsset = sinon.mock()
                        .withArgs({Value: 5.5})
                        .returns(this.assetData);
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    RewireApi.__Rewire__('transformDataToAsset', transformDataToAsset);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, null);
                    this.actual = this.meta.create('Actual', {Value: 5.5});
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                    RewireApi.__ResetDependency__('transformDataToAsset');
                });
                it('it should post the asset creation to the REST URL endpoint with token based authentication headers', () => {
                    this.postFn.calledWith('rest URL/Actual', this.assetData, this.headers).should.be.true;
                });
            });
        });

        describe('given basic authentication', () => {
            describe('given an asset type and asset data', () => {
                describe('when creating an asset', () => {
                    beforeEach(() => {
                        this.assetData = {key: 'value'};
                        this.headers = {
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            Authorization: 'Basic token'
                        };
                        const getV1Urls = sinon.mock()
                            .withArgs('h', 'i', 'http', 80)
                            .returns({
                                rest: 'rest URL'
                            });
                        const transformDataToAsset = sinon.mock()
                            .withArgs({Value: 5.5})
                            .returns(this.assetData);
                        RewireApi.__Rewire__('getV1Urls', getV1Urls);
                        RewireApi.__Rewire__('transformDataToAsset', transformDataToAsset);
                        this.postFn = sinon.stub();

                        this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, null, true);
                        this.actual = this.meta.create('Actual', {Value: 5.5});
                    });
                    afterEach(() => {
                        RewireApi.__ResetDependency__('getV1Urls');
                        RewireApi.__ResetDependency__('transformDataToAsset');
                    });
                    it('it should post the asset creation to the REST URL endpoint with basic authentication headers', () => {
                        this.postFn.calledWith('rest URL/Actual', this.assetData, this.headers).should.be.true;
                    });
                });
            });
        });
    });
});

describe('src/meta.update', function() {
    beforeEach(() => {
        this.actual = undefined;
        this.meta = createMeta('h', 'i', 'http', 80, 'token', () => {
        }, () => {
        });
    });
    describe('given no oid token', () => {
        describe('when updating an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.update()).should.throw();
            });
        });
    });
    describe('given no asset data', () => {
        describe('when creating an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.update('Actual:1001')).should.throw();
            });
        });
    });
    describe('given empty asset data', () => {
        describe('when creating an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.update('Actual:10001', {})).should.throw();
            });
        });
    });
    describe('given token based authentication', () => {
        describe('given an asset type and asset data', () => {
            describe('when updating an asset', () => {
                beforeEach(() => {
                    this.assetData = {key: 'value'};
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            rest: 'rest URL'
                        });
                    const transformDataToAsset = sinon.mock()
                        .withArgs({Value: 5.5})
                        .returns(this.assetData);
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    RewireApi.__Rewire__('transformDataToAsset', transformDataToAsset);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, false);
                    this.actual = this.meta.update('Actual:10011', {Value: 5.5});
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                    RewireApi.__ResetDependency__('transformDataToAsset');
                });
                it('it should post the asset update to the REST URL endpoint with token based authentication header', () => {
                    this.postFn.calledWith('rest URL/Actual/Actual:10011', this.assetData, this.headers).should.be.true;
                });
            });
        });
    });
    describe('given basic authentication', () => {
        describe('given an asset type and asset data', () => {
            describe('when updating an asset', () => {
                beforeEach(() => {
                    this.assetData = {key: 'value'};
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Basic token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            rest: 'rest URL'
                        });
                    const transformDataToAsset = sinon.mock()
                        .withArgs({Value: 5.5})
                        .returns(this.assetData);
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    RewireApi.__Rewire__('transformDataToAsset', transformDataToAsset);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, true);
                    this.actual = this.meta.update('Actual:10011', {Value: 5.5});
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                    RewireApi.__ResetDependency__('transformDataToAsset');
                });
                it('it should post the asset update to the REST URL endpoint with token based authentication header', () => {
                    this.postFn.calledWith('rest URL/Actual/Actual:10011', this.assetData, this.headers).should.be.true;
                });
            });
        });
    });
    describe('given an asset type, asset data, and change comment', () => {
        describe('when updating an asset', () => {
            beforeEach(() => {
                this.assetData = {key: 'value'};
                this.headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: 'Basic token'
                };
                const getV1Urls = sinon.mock()
                    .withArgs('h', 'i', 'http', 80)
                    .returns({
                        rest: 'rest URL'
                    });
                const transformDataToAsset = sinon.mock()
                    .withArgs({Value: 5.5})
                    .returns(this.assetData);
                RewireApi.__Rewire__('getV1Urls', getV1Urls);
                RewireApi.__Rewire__('transformDataToAsset', transformDataToAsset);
                this.postFn = sinon.stub();

                this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, true);
                this.actual = this.meta.update('Actual:10011', {Value: 5.5}, 'change comment');
            });
            afterEach(() => {
                RewireApi.__ResetDependency__('getV1Urls');
                RewireApi.__ResetDependency__('transformDataToAsset');
            });
            it('it should post the asset update to the REST URL endpoint with token based authentication header', () => {
                this.postFn.calledWith(`rest URL/Actual/Actual:10011?comment=${encodeURIComponent('change comment')}`, this.assetData, this.headers).should.be.true;
            });
        });
    });
});

describe('src/meta.query', function() {
    beforeEach(() => {
        this.actual = undefined;
        this.meta = createMeta('h', 'i', 'http', 80, 'token', () => {
        }, () => {
        });
    });
    describe('given no query object', () => {
        describe('when querying meta', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.query()).should.throw();
            });
        });
    });
    describe('given empty query object', () => {
        describe('when querying meta', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.query({})).should.throw();
            });
        });
    });
    describe('given a query object without a from', () => {
        describe('when querying meta', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.query({select: []})).should.throw();
            });
        });
    });
    describe('given a query object without a select', () => {
        describe('when querying meta', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.query({from: 'Story'})).should.throw();
            });
        });
    });
    describe('given a query object with an empty select', () => {
        describe('when querying meta', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.query({from: 'Story', select: []})).should.throw();
            });
        });
    });
    describe('given token based authentication', () => {
        describe('given a valid query object', () => {
            describe('when querying meta', () => {
                beforeEach(() => {
                    this.query = {from: 'Story', select: ['Estimate']};
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            query: 'query Url'
                        });
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, false);
                    this.actual = this.meta.query(this.query);
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                });
                it('it should post the asset update to the query URL endpoint with token based authentication header', () => {
                    this.postFn.calledWith('query Url', this.query, this.headers).should.be.true;
                });
            });
        });
    });
    describe('given basic authentication', () => {
        describe('given a valid query object', () => {
            describe('when querying meta', () => {
                beforeEach(() => {
                    this.query = {from: 'Story', select: ['Estimate']};
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Basic token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            query: 'query Url'
                        });
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, true);
                    this.actual = this.meta.query(this.query);
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                });
                it('it should post the asset update to the query URL endpoint with basic authentication header', () => {
                    this.postFn.calledWith('query Url', this.query, this.headers).should.be.true;
                });
            });
        });
    });
});

describe('src/meta.executeOperation', function() {
    beforeEach(() => {
        this.actual = undefined;
        this.meta = createMeta('h', 'i', 'http', 80, 'token', () => {
        }, () => {
        });
    });
    describe('given no oid token', () => {
        describe('when executing an operation against an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.executeOperation()).should.throw();
            });
        });
    });
    describe('given no operation name', () => {
        describe('when executing an operation against an asset', () => {
            it('it should throw an invariant error', () => {
                (() => this.meta.executeOperation('Actual:10001')).should.throw();
            });
        });
    });
    describe('given token based authentication', () => {
        describe('given an oid token and an operation name', () => {
            describe('when executing an operation against an asset', () => {
                beforeEach(() => {
                    this.operationName = 'operation name';
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            rest: 'rest URL'
                        });
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, false);
                    this.actual = this.meta.executeOperation('Actual:10011', this.operationName);
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                });
                it('it should post the the operation to the REST URL endpoint with token based authentication header', () => {
                    this.postFn.calledWith(`rest URL/Actual/10011?op=${this.operationName}`, null, this.headers).should.be.true;
                });
            });
        });
    });
    describe('given basic authentication', () => {
        describe('given an oid token and an operation name', () => {
            describe('when executing an operation against an asset', () => {
                beforeEach(() => {
                    this.operationName = 'operation name';
                    this.headers = {
                        Accept: 'application/json',
                        'Content-Type': 'application/json',
                        Authorization: 'Basic token'
                    };
                    const getV1Urls = sinon.mock()
                        .withArgs('h', 'i', 'http', 80)
                        .returns({
                            rest: 'rest URL'
                        });
                    RewireApi.__Rewire__('getV1Urls', getV1Urls);
                    this.postFn = sinon.stub();

                    this.meta = createMeta('h', 'i', 'http', 80, 'token', this.postFn, this.getFn, true);
                    this.actual = this.meta.executeOperation('Actual:10011', this.operationName);
                });
                afterEach(() => {
                    RewireApi.__ResetDependency__('getV1Urls');
                });
                it('it should post the the operation to the REST URL endpoint with token basic authentication header', () => {
                    this.postFn.calledWith(`rest URL/Actual/10011?op=${this.operationName}`, null, this.headers).should.be.true;
                });
            });
        });
    });
});

describe('src/meta.queryDefinition', function() {
    beforeEach(() => {
        this.actual = undefined;
    });
    describe('given no asset type', () => {
        describe('when querying for meta data', () => {
            beforeEach(() => {
                this.headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token'
                };
                const getV1Urls = sinon.mock()
                    .withArgs('h', 'i', 'http', 80)
                    .returns({
                        meta: 'meta URL'
                    });
                RewireApi.__Rewire__('getV1Urls', getV1Urls);
                this.getFn = sinon.stub();

                this.meta = createMeta('h', 'i', 'http', 80, 'token', null, this.getFn, false);
                this.actual = this.meta.queryDefinition();
            });
            afterEach(() => {
                RewireApi.__ResetDependency__('getV1Urls');
            });
            it('it should query for all meta data', () => {
                this.getFn.calledWith(`meta URL/`, null, this.headers).should.be.true;
            });
        });
    });
    describe('given an asset type', () => {
        describe('when querying for meta data for the asset type', () => {
            beforeEach(() => {
                this.headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token'
                };
                const getV1Urls = sinon.mock()
                    .withArgs('h', 'i', 'http', 80)
                    .returns({
                        meta: 'meta URL'
                    });
                RewireApi.__Rewire__('getV1Urls', getV1Urls);
                this.getFn = sinon.stub();

                this.meta = createMeta('h', 'i', 'http', 80, 'token', null, this.getFn, false);
                this.actual = this.meta.queryDefinition('Actual');
            });
            afterEach(() => {
                RewireApi.__ResetDependency__('getV1Urls');
            });
            it('it should post the the operation to the REST URL endpoint', () => {
                this.getFn.calledWith(`meta URL/Actual`, null, this.headers).should.be.true;
            });
        });
    });
    describe('given an oidToken', () => {
        describe('when retreiving an activity stream for the asset', () => {
            beforeEach(() => {
                this.headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token'
                };
                const getV1Urls = sinon.mock()
                    .withArgs('h', 'i', 'http', 80)
                    .returns({
                        meta: 'meta URL'
                    });
                RewireApi.__Rewire__('getV1Urls', getV1Urls);
                this.getFn = sinon.stub();

                this.meta = createMeta('h', 'i', 'http', 80, 'token', null, this.getFn, false);
                this.actual = this.meta.getActivityStream('Story:1234');
            });
            afterEach(() => {
                RewireApi.__ResetDependency__('getV1Urls');
            });
            it('it should post the the operation to the REST URL endpoint', () => {
                this.getFn.calledWith(`meta URL/Story:1234`, null, this.headers).should.be.true;
            });
        });
    });
    describe('given token based authentication', () => {
        describe('when querying for meta data', () => {
            beforeEach(() => {
                this.headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer token'
                };
                const getV1Urls = sinon.mock()
                    .withArgs('h', 'i', 'http', 80)
                    .returns({
                        meta: 'meta URL'
                    });
                RewireApi.__Rewire__('getV1Urls', getV1Urls);
                this.getFn = sinon.stub();

                this.meta = createMeta('h', 'i', 'http', 80, 'token', null, this.getFn, false);
                this.actual = this.meta.queryDefinition();
            });
            afterEach(() => {
                RewireApi.__ResetDependency__('getV1Urls');
            });
            it('it should query for all meta data', () => {
                this.getFn.calledWith(`meta URL/`, null, this.headers).should.be.true;
            });
        });
        describe('given basic authentication', () => {
            describe('when querying for meta data', () => {
                describe('when querying for meta data', () => {
                    beforeEach(() => {
                        this.headers = {
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            Authorization: 'Basic token'
                        };
                        const getV1Urls = sinon.mock()
                            .withArgs('h', 'i', 'http', 80)
                            .returns({
                                meta: 'meta URL'
                            });
                        RewireApi.__Rewire__('getV1Urls', getV1Urls);
                        this.getFn = sinon.stub();

                        this.meta = createMeta('h', 'i', 'http', 80, 'token', null, this.getFn, true);
                        this.actual = this.meta.queryDefinition();
                    });
                    afterEach(() => {
                        RewireApi.__ResetDependency__('getV1Urls');
                    });
                    it('it should query for all meta data', () => {
                        this.getFn.calledWith(`meta URL/`, null, this.headers).should.be.true;
                    });
                });
            });
        });
    });
});
