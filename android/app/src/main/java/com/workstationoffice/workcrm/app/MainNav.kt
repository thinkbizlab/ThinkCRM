package com.workstationoffice.workcrm.app

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Insights
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.ViewKanban
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.workstationoffice.workcrm.auth.AuthViewModel
import com.workstationoffice.workcrm.designsystem.L10n
import com.workstationoffice.workcrm.designsystem.t
import com.workstationoffice.workcrm.deals.DealKanbanScreen
import com.workstationoffice.workcrm.deals.DealDetailScreen
import com.workstationoffice.workcrm.kpi.PersonalKpiScreen
import com.workstationoffice.workcrm.masterdata.CustomerListScreen
import com.workstationoffice.workcrm.masterdata.ItemListScreen
import com.workstationoffice.workcrm.kpi.TeamKpiScreen
import com.workstationoffice.workcrm.visits.VisitListScreen
import com.workstationoffice.workcrm.visits.VisitDetailScreen
import com.workstationoffice.workcrm.visits.CheckInScreen
import com.workstationoffice.workcrm.visits.CheckOutScreen
import com.workstationoffice.workcrm.offline.SyncStatusScreen

private sealed class Tab(val route: String, val label: L10n, val icon: androidx.compose.ui.graphics.vector.ImageVector) {
    object Today : Tab("today", L10n.TabToday, Icons.Filled.CalendarMonth)
    object Deals : Tab("deals", L10n.TabDeals, Icons.Filled.ViewKanban)
    object Kpi   : Tab("kpi",   L10n.TabKpi,   Icons.Filled.Insights)
    object More  : Tab("more",  L10n.TabMore,  Icons.Filled.MoreHoriz)
}

@Composable
fun MainNav(auth: AuthViewModel) {
    val nav = rememberNavController()
    val tabs = listOf(Tab.Today, Tab.Deals, Tab.Kpi, Tab.More)
    val backStack by nav.currentBackStackEntryAsState()
    val currentRoute = backStack?.destination?.route

    Scaffold(
        bottomBar = {
            NavigationBar {
                tabs.forEach { tab ->
                    NavigationBarItem(
                        selected = currentRoute?.startsWith(tab.route) == true,
                        onClick = {
                            nav.navigate(tab.route) {
                                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(tab.icon, contentDescription = null) },
                        label = { Text(t(tab.label)) }
                    )
                }
            }
        }
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = Tab.Today.route,
            modifier = Modifier.padding(padding)
        ) {
            composable(Tab.Today.route) { VisitListScreen(onOpenVisit = { id -> nav.navigate("visits/$id") }) }
            composable("visits/{id}") { entry ->
                VisitDetailScreen(
                    visitId = entry.arguments?.getString("id") ?: "",
                    onCheckIn = { id -> nav.navigate("visits/$id/checkin") },
                    onCheckOut = { id -> nav.navigate("visits/$id/checkout") }
                )
            }
            composable("visits/{id}/checkin")  { entry -> CheckInScreen(visitId = entry.arguments?.getString("id") ?: "", onDone = { nav.popBackStack() }) }
            composable("visits/{id}/checkout") { entry -> CheckOutScreen(visitId = entry.arguments?.getString("id") ?: "", onDone = { nav.popBackStack() }) }

            composable(Tab.Deals.route) { DealKanbanScreen(onOpenDeal = { id -> nav.navigate("deals/$id") }) }
            composable("deals/{id}") { entry -> DealDetailScreen(dealId = entry.arguments?.getString("id") ?: "") }

            composable(Tab.Kpi.route) { PersonalKpiScreen(repId = auth.state.value.session?.user?.id) }

            composable(Tab.More.route) {
                MoreScreen(
                    auth = auth,
                    onOpenCustomers = { nav.navigate("more/customers") },
                    onOpenItems     = { nav.navigate("more/items") },
                    onOpenTeamKpi   = { nav.navigate("more/team-kpi") },
                    onOpenSync      = { nav.navigate("more/sync") }
                )
            }
            composable("more/customers") { CustomerListScreen() }
            composable("more/items")     { ItemListScreen() }
            composable("more/team-kpi")  { TeamKpiScreen() }
            composable("more/sync")      { SyncStatusScreen() }
        }
    }
}
