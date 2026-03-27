function getNotesJSONSchema() {
    return {
        type: "object",
        title: "The Note Schema",
        required: [
            "id",
            "title",
            "body",
            "priority",
            "tags",
            "createdAt",
            "updatedAt"
        ],
        properties: {
            id: {type: "string"},
            title: {type: "string"},
            body: {type: "string"},
            createdAt: {type: "string"},
            updatedAt: {type: "string"},
            priority: {
                type: "string",
                enum: ["LOW", "MEDIUM", "HIGH"]
            },
            tags: {
                type: "array",
                items: {
                    type: "string"
                }
            },
        }
    }
}

module.exports = getNotesJSONSchema;