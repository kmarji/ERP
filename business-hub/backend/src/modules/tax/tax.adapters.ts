import { Injectable } from '@nestjs/common';

// Whether the system may submit a return itself. Official submission needs verified API access and legal authorization
// (brief s9.2); until then it is false and filing is a guided manual process with tracked completion.
export abstract class TaxFilingAdapter {
  abstract capabilities(): { submit: boolean; reason: string };
}

@Injectable()
export class StubTaxFilingAdapter extends TaxFilingAdapter {
  capabilities() {
    return { submit: false, reason: 'No verified integration with the tax authority is configured; filing is done manually and tracked here.' };
  }
}
