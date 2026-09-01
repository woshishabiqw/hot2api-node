import PaymentGatewaySettings from '../components/PaymentGatewaySettings';

export default function PaymentGateway() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">支付渠道</h1>
      <PaymentGatewaySettings />
    </div>
  );
}
