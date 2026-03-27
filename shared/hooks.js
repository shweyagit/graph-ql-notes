import {CreateGlobalConfig} from "./config/createConfig.js";
const {Before, After, AfterAll, AfterStep, Status, BeforeAll} = require("@cucumber/cucumber");
const pactum = require("pactum");


global.variables = {input: [{}]}

BeforAll(() => {
    switch(process.env.ENV) {
        case "DEVELOPMENT":
            global.configObject = CreateGlobalConfig('DEVELOPMENT');
            // global.dataObject =

            break;
        default:
            process.exit(1)
    }
})

Before(()=> {
    global.spec =pactum.spec();
    global.responses ={}
})

AfterStep(async function (step) {
    const testStepId = step.pickleStep.id;
    console.log(`Step ${testStepId}`);

});

After(() => {
    variables = {};
    spec.end();
});