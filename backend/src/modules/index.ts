import { Router } from 'express';
import { guestsRouter, roomTypesRouter, ratePlansRouter, roomsRouter, reservationsRouter, checkinsRouter, staysRouter, checkoutsRouter, foliosRouter, invoicesRouter } from './pms/pms.routes';
import { housekeepingRouter, roomItemTypesRouter, roomItemsRouter } from './ops/housekeeping.routes';
import { maintenanceRouter } from './ops/maintenance.routes';
import { laundryRouter, laundryServicesRouter } from './ops/laundry.routes';
import { unitsRouter, productCategoriesRouter, productsRouter, storesRouter, stockRouter, requisitionsRouter, transfersRouter, adjustmentsRouter, stocktakesRouter, recipesRouter } from './inventory/inventory.routes';
import { suppliersRouter, purchaseRequisitionsRouter, quotationsRouter, purchaseOrdersRouter, grnsRouter, supplierInvoicesRouter, supplierPaymentsRouter } from './procurement/procurement.routes';
import { accountsRouter, accountMappingsRouter, taxesRouter, paymentMethodsRouter, currenciesRouter, periodsRouter, journalsRouter, paymentsRouter, customersRouter, receivablesRouter, partyLedgerRouter } from './finance/finance.routes';
import { expenseCategoriesRouter, expensesRouter, pettyCashRouter } from './finance/expenses.routes';
import { businessDaysRouter } from './finance/nightaudit.routes';
import { venuesRouter, eventsRouter, servicesRouter, serviceResourcesRouter, serviceBookingsRouter, clubEventsRouter, staffShiftsRouter } from './events/events.routes';
import { dashboardRouter, reportsRouter, searchRouter, attachmentsRouter, importsRouter, backupsRouter, systemRouter } from './platform/platform.routes';
import { assetCategoriesRouter, assetsRouter } from './platform/assets.routes';
import { printRouter } from './platform/print.routes';
import { outletsRouter, restaurantsRouter, barsRouter, clubsRouter, kitchensRouter, tablesRouter, sectionsRouter, terminalsRouter, menusRouter, menuCategoriesRouter, menuItemsRouter, ordersRouter, kitchenRouter, shiftsRouter } from './fnb/fnb.routes';

/** Module registry: each phase registers its routers here. */
export function registerModuleRoutes(api: Router) {
  // PMS
  api.use('/guests', guestsRouter);
  api.use('/room-types', roomTypesRouter);
  api.use('/rate-plans', ratePlansRouter);
  api.use('/rooms', roomsRouter);
  api.use('/reservations', reservationsRouter);
  api.use('/checkins', checkinsRouter);
  api.use('/stays', staysRouter);
  api.use('/checkouts', checkoutsRouter);
  api.use('/folios', foliosRouter);
  api.use('/invoices', invoicesRouter);
  // Housekeeping / maintenance / assets / laundry
  api.use('/housekeeping', housekeepingRouter);
  api.use('/room-item-types', roomItemTypesRouter);
  api.use('/room-items', roomItemsRouter);
  api.use('/maintenance', maintenanceRouter);
  api.use('/laundry', laundryRouter);
  api.use('/laundry-services', laundryServicesRouter);
  // Inventory
  api.use('/units', unitsRouter);
  api.use('/product-categories', productCategoriesRouter);
  api.use('/products', productsRouter);
  api.use('/stores', storesRouter);
  api.use('/stock', stockRouter);
  api.use('/requisitions', requisitionsRouter);
  api.use('/stock-transfers', transfersRouter);
  api.use('/stock-adjustments', adjustmentsRouter);
  api.use('/stocktakes', stocktakesRouter);
  api.use('/recipes', recipesRouter);
  // Procurement
  api.use('/suppliers', suppliersRouter);
  api.use('/purchase-requisitions', purchaseRequisitionsRouter);
  api.use('/quotations', quotationsRouter);
  api.use('/purchase-orders', purchaseOrdersRouter);
  api.use('/grns', grnsRouter);
  api.use('/supplier-invoices', supplierInvoicesRouter);
  api.use('/supplier-payments', supplierPaymentsRouter);
  // Finance
  api.use('/accounts', accountsRouter);
  api.use('/account-mappings', accountMappingsRouter);
  api.use('/taxes', taxesRouter);
  api.use('/payment-methods', paymentMethodsRouter);
  api.use('/currencies', currenciesRouter);
  api.use('/accounting-periods', periodsRouter);
  api.use('/journals', journalsRouter);
  api.use('/payments', paymentsRouter);
  api.use('/customers', customersRouter);
  api.use('/receivables', receivablesRouter);
  api.use('/party-ledger', partyLedgerRouter);
  api.use('/expense-categories', expenseCategoriesRouter);
  api.use('/expenses', expensesRouter);
  api.use('/petty-cash', pettyCashRouter);
  api.use('/business-days', businessDaysRouter);
  // Events, services, clubs, staff
  api.use('/venues', venuesRouter);
  api.use('/events', eventsRouter);
  api.use('/services', servicesRouter);
  api.use('/service-resources', serviceResourcesRouter);
  api.use('/service-bookings', serviceBookingsRouter);
  api.use('/club-events', clubEventsRouter);
  api.use('/staff-shifts', staffShiftsRouter);
  // Platform: dashboard, reports, search, attachments, imports, backups, assets
  api.use('/dashboard', dashboardRouter);
  api.use('/print', printRouter);
  api.use('/reports', reportsRouter);
  api.use('/search', searchRouter);
  api.use('/attachments', attachmentsRouter);
  api.use('/imports', importsRouter);
  api.use('/backups', backupsRouter);
  api.use('/system', systemRouter);
  api.use('/asset-categories', assetCategoriesRouter);
  api.use('/assets', assetsRouter);
  // F&B
  api.use('/outlets', outletsRouter);
  api.use('/restaurants', restaurantsRouter);
  api.use('/bars', barsRouter);
  api.use('/clubs', clubsRouter);
  api.use('/kitchens', kitchensRouter);
  api.use('/tables', tablesRouter);
  api.use('/sections', sectionsRouter);
  api.use('/pos-terminals', terminalsRouter);
  api.use('/menus', menusRouter);
  api.use('/menu-categories', menuCategoriesRouter);
  api.use('/menu-items', menuItemsRouter);
  api.use('/orders', ordersRouter);
  api.use('/kitchen', kitchenRouter);
  api.use('/shifts', shiftsRouter);
}
