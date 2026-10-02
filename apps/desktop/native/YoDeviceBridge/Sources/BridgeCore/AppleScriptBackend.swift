import Foundation

/// The fixed AppleScript sources for Notes and Mail. They are compiled once per helper process and
/// only ever invoked through handler-call Apple Events whose parameters are NSAppleEventDescriptor
/// values (see AppleScriptBackend). No source is ever built from request data, and there is no
/// generic "run script" path. The Mail template has no `send`, `forward`, `reply`, `redirect`,
/// `move` or `delete` (tests assert this).
public enum AutomationTemplates {
    public static func source(for app: AutomationApp) -> String {
        switch app {
        case .notes: return notes
        case .mail: return mail
        }
    }

    public static let notes = #"""
        -- Yo fixed Notes template. Every value arrives as a handler parameter; nothing is ever spliced
        -- into this source.

        on notes_search(q)
        	tell application "Notes"
        		with timeout of 60 seconds
        			set theIds to id of every note
        			set theNames to name of every note
        			set theDates to modification date of every note
        			set theLocked to password protected of every note
        			ignoring case and diacriticals
        				set bodyIds to id of every note whose plaintext contains q
        			end ignoring
        		end timeout
        	end tell
        	return {theIds, theNames, theDates, theLocked, bodyIds}
        end notes_search

        on notes_folders(idList)
        	set out to {}
        	tell application "Notes"
        		with timeout of 60 seconds
        			repeat with anId in idList
        				set folderName to ""
        				try
        					set folderName to name of container of note id (contents of anId)
        				on error errText number errNum
        					if errNum is -1743 or errNum is -1712 then error errText number errNum
        				end try
        				set end of out to folderName
        			end repeat
        		end timeout
        	end tell
        	return out
        end notes_folders

        on notes_read(theId)
        	tell application "Notes"
        		with timeout of 60 seconds
        			set theNote to note id theId
        			set isLocked to password protected of theNote
        			set theText to ""
        			if not isLocked then set theText to plaintext of theNote
        			set folderName to ""
        			try
        				set folderName to name of container of theNote
        			on error errText number errNum
        				if errNum is -1743 or errNum is -1712 then error errText number errNum
        			end try
        			return {id of theNote, name of theNote, folderName, modification date of theNote, isLocked, theText}
        		end timeout
        	end tell
        end notes_read

        on notes_create(folderName, html)
        	tell application "Notes"
        		with timeout of 60 seconds
        			set targetFolder to missing value
        			if folderName is "" then
        				try
        					set targetFolder to default folder of default account
        				on error errText number errNum
        					if errNum is -1743 or errNum is -1712 then error errText number errNum
        				end try
        				if targetFolder is missing value then set targetFolder to folder "Notes" of default account
        			else
        				set candidates to {default account} & (every account)
        				repeat with anAccount in candidates
        					try
        						set targetFolder to (first folder of anAccount whose name is folderName)
        						exit repeat
        					on error errText number errNum
        						if errNum is -1743 or errNum is -1712 then error errText number errNum
        					end try
        				end repeat
        				if targetFolder is missing value then error "folder not found" number -1728
        			end if
        			set newNote to make new note at targetFolder with properties {body:html}
        			return id of newNote
        		end timeout
        	end tell
        end notes_create
        """#

    public static let mail = #"""
        -- Yo fixed Mail template. Every value arrives as a handler parameter; nothing is ever spliced
        -- into this source. This template can only read messages and save drafts.

        on mail_boxes(kind)
        	tell application "Mail"
        		if kind is "inbox" then
        			set top to inbox
        		else if kind is "sent" then
        			set top to sent mailbox
        		else if kind is "drafts" then
        			set top to drafts mailbox
        		else
        			error "unknown mailbox" number -1700
        		end if
        		set boxes to every mailbox of top
        		if (count of boxes) is 0 then set boxes to {top}
        		return boxes
        	end tell
        end mail_boxes

        on mail_account_id(mb)
        	tell application "Mail"
        		try
        			return id of account of mb
        		on error errText number errNum
        			if errNum is -1743 or errNum is -1712 then error errText number errNum
        			return ""
        		end try
        	end tell
        end mail_account_id

        on mail_scan(kind, cap)
        	set out to {}
        	tell application "Mail"
        		with timeout of 120 seconds
        			repeat with mb in my mail_boxes(kind)
        				set accountId to my mail_account_id(mb)
        				set accountName to ""
        				try
        					set accountName to name of account of mb
        				on error errText number errNum
        					if errNum is -1743 or errNum is -1712 then error errText number errNum
        				end try
        				set total to count of messages of mb
        				if total > 0 then
        					set firstIndex to 1
        					set lastIndex to total
        					if total > cap then
        						-- Keep the newest `cap` messages whichever end of the list they are at.
        						if (date received of message 1 of mb) < (date received of message total of mb) then
        							set firstIndex to total - cap + 1
        						else
        							set lastIndex to cap
        						end if
        					end if
        					set theIds to id of messages firstIndex thru lastIndex of mb
        					set theSubjects to subject of messages firstIndex thru lastIndex of mb
        					set theSenders to sender of messages firstIndex thru lastIndex of mb
        					set theDates to date received of messages firstIndex thru lastIndex of mb
        					set theReads to read status of messages firstIndex thru lastIndex of mb
        					set end of out to {accountId, accountName, theIds, theSubjects, theSenders, theDates, theReads}
        				end if
        			end repeat
        		end timeout
        	end tell
        	return out
        end mail_scan

        on mail_read(kind, accountId, messageId)
        	tell application "Mail"
        		with timeout of 120 seconds
        			repeat with mb in my mail_boxes(kind)
        				if (my mail_account_id(mb)) is accountId then
        					set found to (every message of mb whose id is messageId)
        					if (count of found) > 0 then
        						set theMessage to item 1 of found
        						set toList to address of every to recipient of theMessage
        						set ccList to address of every cc recipient of theMessage
        						return {id of theMessage, subject of theMessage, sender of theMessage, toList, ccList, date received of theMessage, content of theMessage}
        					end if
        				end if
        			end repeat
        		end timeout
        	end tell
        	error "message not found" number -1728
        end mail_read

        on mail_create_draft(toList, ccList, theSubject, theBody)
        	tell application "Mail"
        		with timeout of 60 seconds
        			set draft to make new outgoing message with properties {subject:theSubject, content:theBody, visible:false}
        			tell draft
        				repeat with anAddress in toList
        					make new to recipient at end of to recipients with properties {address:(contents of anAddress)}
        				end repeat
        				repeat with anAddress in ccList
        					make new cc recipient at end of cc recipients with properties {address:(contents of anAddress)}
        				end repeat
        			end tell
        			save draft
        			return id of draft
        		end timeout
        	end tell
        end mail_create_draft
        """#
}

/// Runs the fixed templates with NSAppleScript on the session thread (the main thread).
/// A handler is invoked with a `kASAppleScriptSuite`/`kASSubroutineEvent` event: the handler name
/// goes in `keyASSubroutineName` and the arguments, as a descriptor list, in `keyDirectObject`.
public final class AppleScriptBackend: AutomationBackend {
    private var compiled: [AutomationApp: NSAppleScript] = [:]

    public init() {}

    public func call(_ handler: AutomationHandler, _ args: [ScriptValue]) throws(BridgeError) -> ScriptValue {
        let script = try compiledScript(handler.app)
        var errorInfo: NSDictionary?
        let result = script.executeAppleEvent(Self.handlerEvent(handler, args), error: &errorInfo)
        if let errorInfo {
            let number = (errorInfo[NSAppleScript.errorNumber] as? NSNumber)?.intValue ?? 0
            throw AutomationService.mapError(number)
        }
        return Self.value(result)
    }

    private func compiledScript(_ app: AutomationApp) throws(BridgeError) -> NSAppleScript {
        if let script = compiled[app] { return script }
        guard let script = NSAppleScript(source: AutomationTemplates.source(for: app)) else {
            throw BridgeError(.io, "automation template unavailable")
        }
        var errorInfo: NSDictionary?
        guard script.compileAndReturnError(&errorInfo) else { throw BridgeError(.io, "automation template failed to compile") }
        compiled[app] = script
        return script
    }

    static func fourCharCode(_ text: String) -> FourCharCode {
        text.utf8.reduce(0) { $0 << 8 | FourCharCode($1) }
    }

    /// The handler-call event. Building it sends nothing.
    static func handlerEvent(_ handler: AutomationHandler, _ args: [ScriptValue]) -> NSAppleEventDescriptor {
        let event = NSAppleEventDescriptor(
            eventClass: fourCharCode("ascr"), eventID: fourCharCode("psbr"), targetDescriptor: .currentProcess(),
            returnID: -1 /* kAutoGenerateReturnID */, transactionID: 0 /* kAnyTransactionID */)
        // AppleScript stores handler names in lower case.
        event.setParam(NSAppleEventDescriptor(string: handler.rawValue), forKeyword: fourCharCode("snam"))
        event.setParam(descriptor(.list(args)), forKeyword: fourCharCode("----"))
        return event
    }

    static func descriptor(_ value: ScriptValue) -> NSAppleEventDescriptor {
        switch value {
        case .null: return .null()
        case .bool(let flag): return NSAppleEventDescriptor(boolean: flag)
        case .int(let number):
            if let small = Int32(exactly: number) { return NSAppleEventDescriptor(int32: small) }
            return NSAppleEventDescriptor(double: Double(number))
        case .double(let number): return NSAppleEventDescriptor(double: number)
        case .string(let text): return NSAppleEventDescriptor(string: text)
        case .date(let date): return NSAppleEventDescriptor(date: date)
        case .list(let items):
            let list = NSAppleEventDescriptor.list()
            for (index, item) in items.enumerated() { list.insert(descriptor(item), at: index + 1) }
            return list
        }
    }

    /// Converts a result descriptor. Types the templates never return (records, object
    /// specifiers, …) become `.null`, which the parsers reject where a value is required.
    static func value(_ descriptor: NSAppleEventDescriptor) -> ScriptValue {
        switch descriptor.descriptorType {
        case fourCharCode("list"):
            guard descriptor.numberOfItems > 0 else { return .list([]) }
            return .list((1...descriptor.numberOfItems).map { index in
                descriptor.atIndex(index).map(value) ?? .null
            })
        case fourCharCode("utxt"), fourCharCode("utf8"), fourCharCode("TEXT"), fourCharCode("itxt"):
            return .string(descriptor.stringValue ?? "")
        case fourCharCode("long"), fourCharCode("shor"):
            return .int(Int64(descriptor.int32Value))
        case fourCharCode("comp"), fourCharCode("magn"):
            guard let number = descriptor.coerce(toDescriptorType: fourCharCode("doub"))?.doubleValue else { return .null }
            return .double(number)
        case fourCharCode("doub"), fourCharCode("sing"):
            return .double(descriptor.doubleValue)
        case fourCharCode("true"): return .bool(true)
        case fourCharCode("fals"): return .bool(false)
        case fourCharCode("bool"): return .bool(descriptor.booleanValue)
        case fourCharCode("ldt "):
            return descriptor.dateValue.map(ScriptValue.date) ?? .null
        default:
            // Includes typeNull and `missing value` (typeType 'msng').
            return .null
        }
    }
}
