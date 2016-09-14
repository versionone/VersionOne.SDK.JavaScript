import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import transformDataToAsset from './transformDataToAsset';
chai.use(chaiAsPromised);
chai.should();

describe('src/transformDataToAsset', function() {
    beforeEach(() => {
        this.actual = undefined;
    });
    describe('given an object of asset data', () => {
        beforeEach(() => {
            this.assetData = {
                Value: 20
            };
        });
        describe('when transforming the asset data into something acceptable to the V1 Server instance', () => {
            beforeEach(() => {
                this.actual = transformDataToAsset(this.assetData);
            });
            it('it should return an object with Attributes property', () => {
                chai.should().exist(this.actual.Attributes);
                this.actual.Attributes.Value.value.should.equal(20);
                this.actual.Attributes.Value.act.should.equal('set');
            });
        });
    });

    describe('given an object of asset data with single-relational values', () => {
        beforeEach(() => {
            this.assetData = {
                Value: 20,
                Member: 'Member:20'
            };
        });

        describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
            beforeEach(() => {
                this.actual = transformDataToAsset(this.assetData);
            });
            it('it should transform keys with non-array values to single-relation properties on the output object', () => {
                this.actual.Attributes.Member.value.should.equal('Member:20');
                this.actual.Attributes.Value.value.should.equal(20);
            });
            it('it should set the action to set for each output attribute', () => {
                this.actual.Attributes.Member.act.should.be.equal('set');
                this.actual.Attributes.Value.act.should.be.equal('set');
            });
        });
    });

    describe('given an object of asset data with mutli-relational values that do not contain an idref', () => {
        beforeEach(() => {
            this.assetData = {
                Actuals: ['Actual:10001', 'Actual:10002']
            };
        });

        describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
            beforeEach(() => {
                this.actual = transformDataToAsset(this.assetData);
            });
            it('it should transform keys with array values to a multi-relation asset attribute property on the output object', () => {
                this.actual.Attributes.Actuals.name.should.equal('Actuals');
                this.actual.Attributes.Actuals.value[0].idref.should.equal('Actual:10001');
                this.actual.Attributes.Actuals.value[1].idref.should.equal('Actual:10002');
            });
            it('it should set the action for each value to add', () => {
                this.actual.Attributes.Actuals.value[0].act.should.equal('add');
                this.actual.Attributes.Actuals.value[1].act.should.equal('add');
            });
        });
    });

    describe('given an object of asset data with mutli-relational values that contain an idref', () => {
        beforeEach(() => {
            this.assetData = {
                Actuals: [{idref: 'Actual:10001'}, {idref: 'Actual:10002'}]
            };
        });

        describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
            beforeEach(() => {
                this.actual = transformDataToAsset(this.assetData);
            });
            it('it should transform keys with array values to a multi-relation asset attribute property on the output object', () => {
                this.actual.Attributes.Actuals.name.should.equal('Actuals');
                this.actual.Attributes.Actuals.value[0].idref.should.equal('Actual:10001');
                this.actual.Attributes.Actuals.value[1].idref.should.equal('Actual:10002');
            });
            it('it should set the action for each value to add', () => {
                this.actual.Attributes.Actuals.value[0].act.should.equal('add');
                this.actual.Attributes.Actuals.value[1].act.should.equal('add');
            });
        });

        describe('given the multi-relational values contain an act action', () => {
            beforeEach(() => {
                this.assetData = {
                    Actuals: [{idref: 'Actual:10001', act: 'add'}, {idref: 'Actual:10002', act: 'remove'}]
                };
            });
            describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
                beforeEach(() => {
                    this.actual = transformDataToAsset(this.assetData);
                });
                it('it should set the action for each value to the provided value', () => {
                    this.actual.Attributes.Actuals.value[0].act.should.equal('add');
                    this.actual.Attributes.Actuals.value[1].act.should.equal('remove');
                });
            });
        });
    });
});
