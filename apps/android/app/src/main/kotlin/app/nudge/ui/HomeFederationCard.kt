package app.nudge.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.nudge.AppModel
import app.nudge.R
import app.nudge.ServerProblem
import app.nudge.explain
import kotlinx.coroutines.launch

/** Why the home can't join assistants on other servers yet, followed as the home answers. */
@Composable
fun homeProblem(model: AppModel): ServerProblem.Kind? {
    val session by model.session.collectAsStateWithLifecycle()
    val memberships by model.memberships.collectAsStateWithLifecycle()
    val federation by model.homeFederation.collectAsStateWithLifecycle()
    return remember(session, memberships, federation) { model.homeProblem() }
}

/**
 * What the person's home lacks to join assistants on other servers, and turning federation on
 * there. Shows nothing when it lacks nothing, or while signed out.
 */
@Composable
fun HomeFederationCard(model: AppModel) {
    val scope = rememberCoroutineScope()
    val missing = homeProblem(model) ?: return
    val session by model.session.collectAsStateWithLifecycle()
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.large) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.setup_home_first), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(missing.text))
            if (missing == ServerProblem.Kind.NO_FEDERATION) {
                Button(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            try {
                                model.turnOnFederation()
                                problem = null
                            } catch (error: Exception) {
                                problem = explain(error)
                            } finally {
                                busy = false
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(stringResource(if (busy) R.string.setup_federation_turning_on else R.string.setup_federation_turn_on)) }
                session?.let {
                    Text(
                        stringResource(R.string.setup_federation_reach, it.account.server),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }
}
