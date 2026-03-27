function getCommonConfigs() {
    const commons = {
        "RP_API_KEY": process.env.RP_API_KEY,
        "RP_ENDPOINT": process.env.RP_ENDPOINT,
        "RP_LAUNCH_LINK": process.env.RP_LAUNCH_LINK,
        "LOGGING_LEVEL_COM_EPAM_TA_REPORTPORTAL_WS_CONTROLLER": process.env.LOGGING_LEVEL_COM_EPAM_TA_REPORTPORTAL_WS_CONTROLLER,
        "LOGGING_LEVEL_COM_EPAM_TA_REPORTPORTAL_WS_RABBIT": process.env.LOGGING_LEVEL_COM_EPAM_TA_REPORTPORTAL_WS_RABBIT,
        "K6_PROMETHEUS_RW_SERVER_URL": process.env.K6_PROMETHEUS_RW_SERVER_URL,
        "QA_CHANNEL_WEBHOOK": process.env.QA_CHANNEL_WEBHOOK,
        "PROJ_CHANNEL_WEBHOOK": process.env.PROJ_CHANNEL_WEBHOOK,
        "MFA_EMAIL": process.env.MFA_EMAIL,
        "MFA_PASS": process.env.MFA_PASS,
        "CLIENT_ID": process.env.CLIENT_ID,
        "CLIENT_SECRET": process.env.CLIENT_SECRET,
        "REFRESH_TOKEN": process.env.REFRESH_TOKEN,
        "REDIRECT_URI": process.env.REDIRECT_URI,
    }
    return commons;
}

module.exports = getCommonConfigs;