const getNotes= `query Notes {
    notes {
        id
        title
        body
        priority
        tags
        createdAt
        updatedAt
    }
}`

module.exports = {getNotes}