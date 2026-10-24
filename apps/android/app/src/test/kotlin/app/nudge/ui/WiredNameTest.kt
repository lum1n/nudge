package app.nudge.ui

import app.nudge.attempt
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WiredNameTest {
    @Test
    fun acceptsWhatWiredAccepts() {
        listOf("box", "a", "home-1", "x".repeat(63)).forEach { assertTrue(it, isWiredName(it)) }
    }

    @Test
    fun refusesTheRest() {
        listOf("", "Box", "-box", "box-", "my box", "box.home", "x".repeat(64)).forEach { assertFalse(it, isWiredName(it)) }
    }

    @Test
    fun attemptKeepsFailuresButNotCancellation() {
        assertTrue(attempt { error("down") }.isFailure)
        val cancelled = runCatching { attempt { throw CancellationException("gone") } }
        assertTrue(cancelled.exceptionOrNull() is CancellationException)
    }
}
