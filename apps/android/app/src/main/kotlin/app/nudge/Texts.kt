package app.nudge

import android.content.Context
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes

/**
 * The app's strings for code outside a composable (models, errors), in the language the phone or
 * the app's language setting asks for. Composables use `stringResource` instead.
 */
internal object Texts {
    /** Looks a string up and fills in its arguments. Tests without Android set their own. */
    var string: (id: Int, args: Array<out Any>) -> String = { _, _ -> error("Texts.use wasn't called") }

    /** Looks a quantity string up for a count and fills in its arguments. */
    var quantity: (id: Int, count: Int, args: Array<out Any>) -> String = { _, _, _ -> error("Texts.use wasn't called") }

    /** Reads strings from the app's resources, which follow the language settings. */
    fun use(context: Context) {
        string = { id, args -> context.getString(id, *args) }
        quantity = { id, count, args -> context.resources.getQuantityString(id, count, *args) }
    }
}

/** One of the app's strings, with its arguments filled in. */
fun text(@StringRes id: Int, vararg args: Any): String = Texts.string(id, args)

/** One of the app's quantity strings: "1 room", "3 rooms". */
fun quantityText(@PluralsRes id: Int, count: Int, vararg args: Any): String = Texts.quantity(id, count, args)
