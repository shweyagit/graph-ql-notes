import getCommonConfigs from "./global/env-independant.js";


function CreateGlobalConfig(env) {
    let globalConfig;
    const commonConfig = getCommonConfigs()
    switch(env) {
        case "DEVELOPMENT":
            globalConfig =  {
            BASEURL: process.env.BASE_URL,
                ...commonConfig
        }
        break;
        default:
            process.exit(1)
    }
    return globalConfig
}

module.exports = {CreateGlobalConfig}