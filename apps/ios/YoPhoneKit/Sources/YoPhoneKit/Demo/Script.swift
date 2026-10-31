import Foundation

/// What the demo's pretend Yo says. Sample content only: no real people, places or accounts.
enum Script {
    struct Turn: Sendable {
        /// Working details, one per step.
        var steps: [String]
        var reply: String
        var card: Card?
    }

    struct Card: Sendable {
        var request: RequestCard
        var approved: String
        var denied: String

        func followUp(approved isApproved: Bool, answer: String?) -> Turn {
            if let answer {
                return Turn(steps: ["Holding your seat"], reply: approved.replacingOccurrences(of: "{answer}", with: answer))
            }
            return Turn(steps: [isApproved ? "Booking" : "Wrapping up"], reply: isApproved ? approved : denied)
        }
    }

    static func reply(to text: String) -> Turn {
        let t = text.lowercased()
        if ["table", "book", "dinner", "restaurant", "italian"].contains(where: t.contains) { return table }
        if ["inbox", "email", "mail"].contains(where: t.contains) { return inbox }
        if ["flight", "fly", "denver", "trip"].contains(where: t.contains) { return flights }
        return hello
    }

    static func card(for requestId: String) -> Card? {
        [tableCard, flightCard].first { $0.request.requestId == requestId }
    }

    static let table = Turn(
        steps: ["Checking tables near you", "Reading reviews"],
        reply: """
        Three spots have a table for 4 on Friday at 7:30:

        1. **Trattoria Sole** · cozy, handmade pasta
        2. **Osteria Lumen** · bigger room, great wine list
        3. **Nonna's Kitchen** · casual, family style

        Trattoria Sole has the best reviews.
        """,
        card: tableCard
    )

    static let tableCard = Card(
        request: RequestCard(
            requestId: "demo-table",
            kind: .approval,
            title: "Book Trattoria Sole for 4?",
            detail: "Friday at 7:30 pm · Table for 4 · No deposit needed",
            agent: DemoCore.agentName
        ),
        approved: "Booked: **Trattoria Sole, Friday at 7:30 pm**, table for 4. It's on your calendar with a reminder at 6:45.",
        denied: "No problem, I didn't book anything."
    )

    static let inbox = Turn(
        steps: ["Reading your inbox", "Sorting what matters"],
        reply: """
        **3 things need you today:**

        1. **Lease renewal**: your landlord needs an answer by Friday.
        2. **Dentist**: your cleaning moved to Tuesday at 10:30.
        3. **Team offsite**: the agenda is out, nothing to do yet.

        The other 14 are newsletters and receipts. Want me to draft the lease reply?
        """
    )

    static let flights = Turn(
        steps: ["Comparing flights"],
        reply: """
        Two good nonstops to Denver on Friday morning:

        1. **Peregrine Air 7:05 am** · lands 8:41 · $189
        2. **Sunline 9:40 am** · lands 11:15 · $214

        Peregrine Air is cheaper and gets you there before 9.
        """,
        card: flightCard
    )

    static let flightCard = Card(
        request: RequestCard(
            requestId: "demo-flight",
            kind: .question,
            title: "Which flight should I hold?",
            detail: "Holds are free for 24 hours.",
            options: ["Peregrine Air 7:05 am · $189", "Sunline 9:40 am · $214"],
            agent: DemoCore.agentName
        ),
        approved: "Held **{answer}** for 24 hours. I'll remind you tomorrow morning before it expires.",
        denied: "Okay, no hold."
    )

    static let hello = Turn(
        steps: ["Thinking"],
        reply: """
        Hi! This is the **demo**: a pretend Yo that lives on this phone. Try one of these:

        - *Book a table for 4 on Friday*
        - *Summarize my inbox*
        - *Compare flights to Denver*

        Your real Yo runs on your computer and texts you back here.
        """
    )
}
