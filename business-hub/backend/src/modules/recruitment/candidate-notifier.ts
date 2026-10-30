import { Global, Injectable, Logger, Module } from '@nestjs/common';

export interface CandidateMessage {
  phone?: string | null;
  email?: string | null;
  template: string;
  text: string;
  textAr?: string;
}

// Message channel to candidates and new hires (SMS, WhatsApp or email provider). The stub records what would be sent.
export abstract class CandidateNotifier {
  abstract send(msg: CandidateMessage): Promise<void>;
}

@Injectable()
export class StubCandidateNotifier extends CandidateNotifier {
  private readonly log = new Logger('CandidateNotification');
  readonly sent: CandidateMessage[] = [];

  async send(msg: CandidateMessage) {
    this.sent.push(msg);
    this.log.log(`-> ${msg.phone ?? msg.email ?? 'n/a'}: [${msg.template}] ${msg.text}`);
  }
}

@Global()
@Module({
  providers: [StubCandidateNotifier, { provide: CandidateNotifier, useExisting: StubCandidateNotifier }],
  exports: [CandidateNotifier, StubCandidateNotifier],
})
export class CandidateNotifierModule {}
