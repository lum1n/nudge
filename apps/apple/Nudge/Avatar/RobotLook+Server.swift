import Nudge

extension RobotLook {
    /// What the server says, as this app draws it: the app icon's robot for none, and its eyes or
    /// nothing worn for a choice made by a newer app.
    init(_ appearance: Appearance?) {
        guard let appearance, appearance.body.count == 2 else {
            self = .nudge
            return
        }
        self.init(
            body: (appearance.body[0], appearance.body[1]),
            eyes: appearance.eyes,
            sparks: appearance.sparks,
            eyeShape: EyeShape(rawValue: appearance.eyeShape) ?? RobotLook.nudge.eyeShape,
            accessory: Accessory(rawValue: appearance.accessory) ?? .none)
    }

    /// As the server keeps it.
    var appearance: Appearance {
        Appearance(
            body: [body.0, body.1], eyes: eyes, sparks: sparks, eyeShape: eyeShape.rawValue,
            accessory: accessory.rawValue)
    }
}

extension Session {
    /// How the assistant's robot looks, from its room list; the app icon's until that arrives.
    var look: RobotLook { RobotLook(roomList.value?.view?.appearance) }
}
