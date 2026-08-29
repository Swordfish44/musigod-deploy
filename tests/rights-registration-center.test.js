'use strict'
const assert=require('assert');const r=require('../lib/rights-registration-rules')
let a=r.evaluate({songwriter:true,us_pro:'BMI',publisher:true,publisher_pro:'ASCAP',controls_compositions:true,featured_artist:true,master_owner:true,international_collection:true,authorization_executed:false});const by=k=>a.find(x=>x.key===k)
assert.equal(by('bmi_writer').applicable,true);assert.equal(by('ascap_writer').blocked,true);assert.equal(by('ascap_writer').applicable,false);assert.equal(by('ascap_publisher').applicable,true);assert.equal(by('soundexchange').applicable,true);assert.equal(by('mdx').authorization_sufficient,false)
assert(r.validateIpi('12345678901'));assert(!r.validateIpi('work-123'));assert(r.validateIsrc('US-ABC-26-12345'));assert(!r.validateIsrc('123'));assert(r.validateIswc('T-123.456.789-0'))
assert(r.validateStatusTransition('NOT_STARTED','IN_PROGRESS'));assert(!r.validateStatusTransition('NOT_STARTED','ACTIVE'));assert(r.validateStatusTransition('PENDING_VERIFICATION','ACTIVE'));assert.equal(r.STATUSES.length,8)
console.log('rights-registration-center: rules, identifiers, PRO exclusivity, rights separation, and transitions pass')
