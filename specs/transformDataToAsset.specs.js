import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
chai.use(chaiAsPromised);
let should = chai.should();
import Sut from './../dist/transformDataToAsset';

describe('src/transformDataToAsset', function () {
	describe('given an object of asset data', () => {
		let assetData, actual;
		beforeEach(() => {
			assetData = {
				Value: 20
			};
		});
		describe('when transforming the asset data into something acceptable to the V1 Server instance', () => {
			beforeEach(() => {
				actual = Sut(assetData);
			});
			it.skip('it should return an object with Attributes property', () => {
				should.exist(actual.Attributes);
			});
		});
	});

	describe('given an object of asset data with single-relational values', () => {
		let assetData, actual;
		beforeEach(() => {
			actual = undefined;
			assetData = {
				Value: 20,
				Member: 'Member:20'
			};
		});

		describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
			beforeEach(() => {
				actual = Sut(assetData);
			});

			it('it should transform keys with non-array values to single-relation properties on the output object', () => {
				actual.Attributes.Member.value.should.equal('Member:20');
				actual.Attributes.Value.value.should.equal(20);
			});

			it('it should set the action to set for each output attribute', () => {
				actual.Attributes.Member.act.should.be.equal('set');
				actual.Attributes.Value.act.should.be.equal('set');
			});
		});
	});

	describe('given an object of asset data with mutli-relational values that do not contain an idref', () => {
		let assetData, actual;
		beforeEach(() => {
			actual = undefined;
			assetData = {
				Actuals: ['Actual:10001', 'Actual:10002']
			};
		});

		describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
			beforeEach(() => {
				actual = Sut(assetData);
			});

			it('it should transform keys with array values to a multi-relation asset attribute property on the output object', () => {
				actual.Attributes.Actuals.name.should.equal('Actuals');
				actual.Attributes.Actuals.value[0].idref.should.equal('Actual:10001');
				actual.Attributes.Actuals.value[1].idref.should.equal('Actual:10002');
			});

			it('it should set the action for each value to add', () => {
				actual.Attributes.Actuals.value[0].act.should.equal('add');
				actual.Attributes.Actuals.value[1].act.should.equal('add');
			});
		});
	});

	describe('given an object of asset data with mutli-relational values that contain an idref', () => {
		let assetData, actual;
		beforeEach(() => {
			actual = undefined;
			assetData = {
				Actuals: [{idref: 'Actual:10001'}, {idref: 'Actual:10002'}]
			};
		});

		describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
			beforeEach(() => {
				actual = Sut(assetData);
			});

			it('it should transform keys with array values to a multi-relation asset attribute property on the output object', () => {
				actual.Attributes.Actuals.name.should.equal('Actuals');
				actual.Attributes.Actuals.value[0].idref.should.equal('Actual:10001');
				actual.Attributes.Actuals.value[1].idref.should.equal('Actual:10002');
			});

			it('it should set the action for each value to add', () => {
				actual.Attributes.Actuals.value[0].act.should.equal('add');
				actual.Attributes.Actuals.value[1].act.should.equal('add');
			});
		});

		describe('given the multi-relational values contain an act action', () => {
			beforeEach(() => {
				assetData = {
					Actuals: [{idref: 'Actual:10001', act: 'add'}, {idref: 'Actual:10002', act: 'remove'}]
				};
			});
			describe('when transforming the asset data to something acceptable to the V1 Server instance', () => {
				beforeEach(() => {
					actual = Sut(assetData);
				});

				it('it should set the action for each value to the provided value', () => {
					actual.Attributes.Actuals.value[0].act.should.equal('add');
					actual.Attributes.Actuals.value[1].act.should.equal('remove');
				});
			});
		});
	});
});
